mod terminal;

use tauri::{ipc::Channel, Manager, State};
use terminal::{SessionInfo, TerminalEvent, TerminalManager};

#[tauri::command]
async fn create_terminal(
    manager: State<'_, TerminalManager>,
    shell: String,
    cwd: Option<String>,
    rows: u16,
    cols: u16,
    on_event: Channel<TerminalEvent>,
) -> Result<SessionInfo, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.create(shell, cwd, rows, cols, move |event| {
            on_event.send(event).map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn write_terminal(
    manager: State<'_, TerminalManager>,
    id: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.write(&id, &bytes))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn resize_terminal(
    manager: State<'_, TerminalManager>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.resize(&id, rows, cols))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn ack_terminal(manager: State<'_, TerminalManager>, id: String, count: usize) {
    manager.ack(&id, count);
}

#[tauri::command]
async fn close_terminal(manager: State<'_, TerminalManager>, id: String) -> Result<(), String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.close(&id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_fonts() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        let mut names: Vec<_> = db
            .faces()
            .flat_map(|face| face.families.iter().map(|(name, _)| name.clone()))
            .collect();
        names.sort_by_key(|name| name.to_lowercase());
        names.dedup();
        names
    })
    .await
    .map_err(|e| e.to_string())
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(TerminalManager::default())
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                // A reload must not orphan quiet shells whose output channel
                // disappeared with the old document.
                webview.state::<TerminalManager>().close_all();
            }
        })
        .invoke_handler(tauri::generate_handler![
            create_terminal,
            write_terminal,
            resize_terminal,
            ack_terminal,
            close_terminal,
            list_fonts
        ])
        .build(tauri::generate_context!())
        .expect("Multi Terminal 초기화 실패");
    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            app.state::<TerminalManager>().close_all();
        }
    });
}
