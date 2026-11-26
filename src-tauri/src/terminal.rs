use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Arc, Condvar, Mutex},
};
use uuid::Uuid;

pub const MAX_SESSIONS: usize = 4;
const OUTPUT_WINDOW: usize = 256 * 1024;

#[derive(Clone, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum TerminalEvent {
    Data { bytes: Vec<u8> },
    Exit { code: Option<u32> },
    Error { message: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub shell: String,
    pub cwd: String,
    pub pid: Option<u32>,
}

#[derive(Default)]
struct FlowState {
    pending: usize,
    stopped: bool,
    shell_exited: bool,
}

#[derive(Default)]
struct Flow {
    state: Mutex<FlowState>,
    ready: Condvar,
}

pub struct Session {
    stop_lock: Mutex<()>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    flow: Arc<Flow>,
    pid: Option<u32>,
}

impl Session {
    fn stop(&self) {
        let _stop = self.stop_lock.lock().unwrap_or_else(|e| e.into_inner());
        let shell_exited = {
            let mut flow = self.flow.state.lock().unwrap_or_else(|e| e.into_inner());
            if flow.stopped {
                return;
            }
            flow.stopped = true;
            self.flow.ready.notify_all();
            flow.shell_exited
        };
        // Kill descendants as well as the shell. taskkill is scoped to the PID
        // created by this PTY; CREATE_NO_WINDOW avoids a console flash.
        #[cfg(windows)]
        if let Some(pid) = self.pid.filter(|_| !shell_exited) {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("taskkill.exe")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(0x08000000)
                .output();
        }
        if !shell_exited {
            let _ = self.killer.lock().unwrap_or_else(|e| e.into_inner()).kill();
        }
        self.writer.lock().unwrap_or_else(|e| e.into_inner()).take();
        self.master.lock().unwrap_or_else(|e| e.into_inner()).take();
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Clone, Default)]
pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, Arc<Session>>>>,
}

fn size(rows: u16, cols: u16) -> Result<PtySize, String> {
    if rows == 0 || cols == 0 || rows > 1000 || cols > 1000 {
        return Err("터미널 크기는 1~1000행/열이어야 합니다.".into());
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}

fn shell_command(shell: &str) -> Result<CommandBuilder, String> {
    #[cfg(windows)]
    {
        let mut command = match shell {
            "powershell" => CommandBuilder::new("powershell.exe"),
            "pwsh" => CommandBuilder::new("pwsh.exe"),
            "cmd" => CommandBuilder::new("cmd.exe"),
            "wsl" => CommandBuilder::new("wsl.exe"),
            _ => return Err("지원하지 않는 셸입니다.".into()),
        };
        if shell == "powershell" || shell == "pwsh" {
            command.args(["-NoLogo", "-NoExit", "-Command",
                "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding"]);
        }
        if shell == "cmd" {
            command.args(["/K", "chcp 65001 > nul"]);
        }
        Ok(command)
    }
    #[cfg(not(windows))]
    {
        let executable = match shell {
            "default" => std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()),
            "bash" => "/bin/bash".into(),
            "zsh" => "/bin/zsh".into(),
            _ => return Err("지원하지 않는 셸입니다.".into()),
        };
        let mut command = CommandBuilder::new(executable);
        command.arg("-l");
        Ok(command)
    }
}

impl TerminalManager {
    pub fn create(
        &self,
        shell: String,
        cwd: Option<String>,
        rows: u16,
        cols: u16,
        emit: impl Fn(TerminalEvent) -> Result<(), String> + Send + 'static,
    ) -> Result<SessionInfo, String> {
        let dimensions = size(rows, cols)?;
        // Keep the lock through spawning: simultaneous requests cannot exceed 4.
        let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        if sessions.len() >= MAX_SESSIONS {
            return Err("한 창에서 터미널은 최대 4개까지 실행할 수 있습니다.".into());
        }
        let cwd = cwd.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| {
            std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .unwrap_or_else(|_| ".".into())
        });
        let path = std::path::Path::new(&cwd);
        if !path.is_dir() {
            return Err(format!("작업 폴더가 존재하지 않습니다: {cwd}"));
        }
        let mut command = shell_command(&shell)?;
        command.cwd(path);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        let pair = native_pty_system()
            .openpty(dimensions)
            .map_err(|e| e.to_string())?;
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| format!("셸 실행 실패: {e}"))?;
        let pid = child.process_id();
        let flow = Arc::new(Flow::default());
        let session = Arc::new(Session {
            stop_lock: Mutex::new(()),
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
            killer: Mutex::new(child.clone_killer()),
            flow: flow.clone(),
            pid,
        });
        drop(pair.slave);
        let id = Uuid::new_v4().to_string();
        sessions.insert(id.clone(), session.clone());
        let manager = Arc::downgrade(&self.sessions);
        let thread_id = id.clone();
        let (exit_tx, exit_rx) = std::sync::mpsc::channel();
        // ConPTY does not necessarily produce EOF when the shell exits until
        // its host handle is closed. Close from a waiter, never the reader:
        // ClosePseudoConsole may block until the reader has drained its output.
        std::thread::spawn(move || {
            let code = child.wait().ok().map(|status| status.exit_code());
            session
                .flow
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .shell_exited = true;
            let _ = exit_tx.send(code);
            session
                .writer
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take();
            let master = session
                .master
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take();
            drop(master);
        });
        std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            loop {
                {
                    let mut state = flow.state.lock().unwrap_or_else(|e| e.into_inner());
                    while state.pending >= OUTPUT_WINDOW && !state.stopped {
                        state = flow.ready.wait(state).unwrap_or_else(|e| e.into_inner());
                    }
                }
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        // Keep draining even during close: otherwise Windows'
                        // synchronous ClosePseudoConsole can deadlock.
                        if flow.state.lock().unwrap_or_else(|e| e.into_inner()).stopped {
                            continue;
                        }
                        flow.state.lock().unwrap_or_else(|e| e.into_inner()).pending += count;
                        if emit(TerminalEvent::Data {
                            bytes: buffer[..count].to_vec(),
                        })
                        .is_err()
                        {
                            if let Some(sessions) = manager.upgrade() {
                                let id = thread_id.clone();
                                std::thread::spawn(move || {
                                    let session = sessions
                                        .lock()
                                        .unwrap_or_else(|e| e.into_inner())
                                        .remove(&id);
                                    if let Some(session) = session {
                                        session.stop();
                                    }
                                });
                            }
                        }
                    }
                    Err(error) => {
                        if !flow.state.lock().unwrap_or_else(|e| e.into_inner()).stopped {
                            let _ = emit(TerminalEvent::Error {
                                message: error.to_string(),
                            });
                        }
                        break;
                    }
                }
            }
            // Remove and stop outside the manager lock so other panes stay responsive.
            let code = exit_rx.recv().ok().flatten();
            let session = manager
                .upgrade()
                .and_then(|m| m.lock().ok()?.remove(&thread_id));
            drop(session);
            let _ = emit(TerminalEvent::Exit { code });
        });
        Ok(SessionInfo {
            id,
            shell,
            cwd,
            pid,
        })
    }

    fn get(&self, id: &str) -> Result<Arc<Session>, String> {
        self.sessions
            .lock()
            .map_err(|e| e.to_string())?
            .get(id)
            .cloned()
            .ok_or_else(|| "종료되었거나 존재하지 않는 터미널입니다.".into())
    }

    pub fn write(&self, id: &str, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() > 1024 * 1024 {
            return Err("입력은 한 번에 1MB 이하여야 합니다.".into());
        }
        let session = self.get(id)?;
        let mut writer = session.writer.lock().map_err(|e| e.to_string())?;
        let writer = writer.as_mut().ok_or("터미널 입력이 닫혔습니다.")?;
        writer
            .write_all(bytes)
            .and_then(|_| writer.flush())
            .map_err(|e| e.to_string())
    }

    pub fn resize(&self, id: &str, rows: u16, cols: u16) -> Result<(), String> {
        let dimensions = size(rows, cols)?;
        let session = self.get(id)?;
        let master = session.master.lock().map_err(|e| e.to_string())?;
        master
            .as_ref()
            .ok_or("터미널이 닫혔습니다.")?
            .resize(dimensions)
            .map_err(|e| e.to_string())
    }

    pub fn ack(&self, id: &str, count: usize) {
        if let Ok(session) = self.get(id) {
            let mut state = session.flow.state.lock().unwrap_or_else(|e| e.into_inner());
            state.pending = state.pending.saturating_sub(count);
            session.flow.ready.notify_all();
        }
    }

    pub fn close(&self, id: &str) -> Result<(), String> {
        let session = self
            .sessions
            .lock()
            .map_err(|e| e.to_string())?
            .get(id)
            .cloned();
        if let Some(session) = session {
            session.stop();
        }
        self.sessions.lock().map_err(|e| e.to_string())?.remove(id);
        Ok(())
    }

    pub fn close_all(&self) {
        let sessions: Vec<_> = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
            .map(|(_, s)| s)
            .collect();
        for session in sessions {
            session.stop();
        }
    }

    #[cfg(test)]
    fn count(&self) -> usize {
        self.sessions.lock().unwrap().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::mpsc,
        time::{Duration, Instant},
    };

    fn default_shell() -> String {
        if cfg!(windows) {
            "powershell"
        } else {
            "default"
        }
        .into()
    }

    #[test]
    fn four_real_ptys_reject_fifth_and_reuse_closed_slot() {
        let manager = TerminalManager::default();
        let mut sessions = Vec::new();
        for _ in 0..4 {
            sessions.push(
                manager
                    .create(default_shell(), None, 24, 80, |_| Ok(()))
                    .unwrap(),
            );
        }
        assert_eq!(manager.count(), 4);
        let fifth = manager.create(default_shell(), None, 24, 80, |_| Ok(()));
        assert!(fifth.err().unwrap().contains("최대 4개"));
        manager.close(&sessions[0].id).unwrap();
        let replacement = manager
            .create(default_shell(), None, 30, 120, |_| Ok(()))
            .unwrap();
        manager.resize(&replacement.id, 40, 100).unwrap();
        assert!(manager.resize(&replacement.id, 0, 80).is_err());
        manager.close_all();
        assert_eq!(manager.count(), 0);
    }

    #[test]
    fn unicode_roundtrip_and_exit_release_slot() {
        let manager = TerminalManager::default();
        let (tx, rx) = mpsc::channel();
        let session = manager
            .create(default_shell(), None, 24, 120, move |event| {
                tx.send(event).map_err(|e| e.to_string())
            })
            .unwrap();
        let command = if cfg!(windows) {
            "Write-Output ('검증' + '한글✓'); exit\r"
        } else {
            "printf '검증한글✓\\n'; exit\r"
        };
        if !cfg!(windows) {
            manager.write(&session.id, command.as_bytes()).unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(25);
        let mut output = Vec::new();
        let mut exited = false;
        while Instant::now() < deadline {
            if let Ok(event) = rx.recv_timeout(Duration::from_secs(1)) {
                match event {
                    TerminalEvent::Data { bytes } => {
                        if cfg!(windows) && bytes.windows(4).any(|b| b == b"\x1b[6n") {
                            manager.write(&session.id, b"\x1b[1;1R").unwrap();
                            manager.write(&session.id, command.as_bytes()).unwrap();
                        }
                        manager.ack(&session.id, bytes.len());
                        output.extend(bytes);
                    }
                    TerminalEvent::Exit { .. } => {
                        exited = true;
                        break;
                    }
                    TerminalEvent::Error { message } => panic!("{message}"),
                }
            }
        }
        manager.close_all();
        assert!(
            exited,
            "shell did not exit: {}",
            String::from_utf8_lossy(&output)
        );
        assert!(
            String::from_utf8_lossy(&output).contains("검증한글✓"),
            "{}",
            String::from_utf8_lossy(&output)
        );
        assert_eq!(manager.count(), 0);
    }

    #[test]
    fn simultaneous_creates_never_exceed_four() {
        let manager = TerminalManager::default();
        let barrier = Arc::new(std::sync::Barrier::new(8));
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let manager = manager.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    manager
                        .create(default_shell(), None, 24, 80, |_| Ok(()))
                        .is_ok()
                })
            })
            .collect();
        let successful = workers
            .into_iter()
            .map(|worker| usize::from(worker.join().unwrap()))
            .sum::<usize>();
        let count = manager.count();
        manager.close_all();
        assert_eq!(successful, 4);
        assert_eq!(count, 4);
    }

    #[test]
    fn closing_a_backpressured_pty_does_not_deadlock() {
        let manager = TerminalManager::default();
        let (tx, rx) = mpsc::channel();
        let session = manager
            .create(default_shell(), None, 24, 100, move |event| {
                tx.send(event).map_err(|e| e.to_string())
            })
            .unwrap();
        let command = if cfg!(windows) {
            "1..10000 | ForEach-Object { 'x' * 100 }\r"
        } else {
            "yes 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'\r"
        };
        if !cfg!(windows) {
            manager.write(&session.id, command.as_bytes()).unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut pending = 0;
        while pending < OUTPUT_WINDOW && Instant::now() < deadline {
            if let Ok(TerminalEvent::Data { bytes }) = rx.recv_timeout(Duration::from_secs(1)) {
                if cfg!(windows) && bytes.windows(4).any(|b| b == b"\x1b[6n") {
                    manager.write(&session.id, b"\x1b[1;1R").unwrap();
                    manager.write(&session.id, command.as_bytes()).unwrap();
                }
                // Deliberately withhold ACKs until the reader's window fills.
                pending += bytes.len();
            }
        }
        let start = Instant::now();
        manager.close(&session.id).unwrap();
        assert!(
            pending >= OUTPUT_WINDOW,
            "output never reached the flow-control window"
        );
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "close blocked while output was paused"
        );
        assert_eq!(manager.count(), 0);
    }

    #[test]
    fn invalid_requests_do_not_consume_slots() {
        let manager = TerminalManager::default();
        assert!(manager
            .create("invalid".into(), None, 24, 80, |_| Ok(()))
            .is_err());
        assert!(manager
            .create(
                default_shell(),
                Some("Z:/nonexistent-multiterminal-folder".into()),
                24,
                80,
                |_| Ok(())
            )
            .is_err());
        assert_eq!(manager.count(), 0);
    }
}
