use crate::commands::AppError;
pub fn validate_url(value: &str) -> Result<tauri::Url, AppError> {
    let invalid = || AppError::new("Invalid scoped preview URL");
    if value.len() > 6000 || value.contains(['\\', '\r', '\n', '\t']) { return Err(invalid()); }
    let url = tauri::Url::parse(value).map_err(|_| invalid())?;
    let segments: Vec<_> = url.path().split('/').collect();
    let uuid = |v: &str| v.len() == 36 && v.bytes().enumerate().all(|(i,c)| if [8,13,18,23].contains(&i) { c == b'-' } else { c.is_ascii_hexdigit() });
    let query = url.query().ok_or_else(invalid)?;
    let cap = query.strip_prefix("cap=").ok_or_else(invalid)?;
    let token: Vec<_> = cap.split('.').collect();
    if url.scheme() != "https" || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some()
        || segments.len() != 5 || segments[1] != "preview" || !uuid(segments[2]) || !uuid(segments[3]) || segments[4] != "index.html"
        || token.len() != 3 || token.iter().any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
        || !value.contains(&format!("{}/preview/{}/{}/index.html?cap=",url.origin().ascii_serialization(),segments[2],segments[3])) {
        return Err(invalid());
    }
    Ok(url)
}
#[tauri::command]
pub fn open_remote_preview<R: tauri::Runtime>(url: String, webview: tauri::WebviewWindow<R>) -> Result<(), AppError> {
    if webview.label() != "main" { return Err(AppError {code:"FORBIDDEN".into(),message:"Preview is restricted to the main local window".into()}); }
    let parsed = validate_url(&url)?;
    launch(parsed.as_str())
}
// Test builds validate native ACL/schema only; they never launch a native browser.
#[cfg(test)]
fn launch(_url: &str) -> Result<(), AppError> { Ok(()) }
#[cfg(all(not(test),windows))]
fn launch(url: &str) -> Result<(), AppError> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    let value:Vec<u16>=url.encode_utf16().chain(Some(0)).collect();
    let operation:Vec<u16>="open".encode_utf16().chain(Some(0)).collect();
    let result=unsafe{ShellExecuteW(std::ptr::null_mut(),operation.as_ptr(),value.as_ptr(),std::ptr::null(),std::ptr::null(),1)};
    if result as isize <=32 { return Err(AppError::new("Could not open preview browser")); } Ok(())
}
#[cfg(all(not(test),target_os="macos"))]
fn launch(url: &str) -> Result<(), AppError> { std::process::Command::new("/usr/bin/open").arg("--").arg(url).spawn().map_err(|_|AppError::new("Could not open preview browser"))?; Ok(()) }
#[cfg(all(not(test),not(windows),not(target_os="macos")))]
fn launch(_url:&str)->Result<(),AppError>{Err(AppError::new("Unsupported desktop platform"))}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scoped_https_url_only() {
        let good="https://control.example/preview/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/index.html?cap=abc.def.ghi";
        assert!(validate_url(good).is_ok());
        for bad in [good.replace("https:","http:"),good.replace("https:","file:"),good.replace("control.example","user:password@control.example"),format!("{good}#fragment"),format!("{good}&token=extra"),good.replace("/preview/","/admin/"),good.replace("abc.def.ghi","%0ashell"),good.replace("index.html","../index.html")] {
            assert!(validate_url(&bad).is_err(), "accepted {bad}");
        }
    }
    #[test]
    fn opener_acl_is_main_local_only_without_launching_gui() {
        let app=tauri::test::mock_builder().invoke_handler(tauri::generate_handler![open_remote_preview]).build(tauri::generate_context!()).unwrap();
        let main=tauri::WebviewWindowBuilder::new(&app,"main",Default::default()).build().unwrap();
        let other=tauri::WebviewWindowBuilder::new(&app,"generated",Default::default()).build().unwrap();
        let invoke=|window:&tauri::WebviewWindow<tauri::test::MockRuntime>,origin:&str|tauri::test::get_ipc_response(window,tauri::webview::InvokeRequest{cmd:"open_remote_preview".into(),callback:tauri::ipc::CallbackFn(0),error:tauri::ipc::CallbackFn(1),url:origin.parse().unwrap(),body:tauri::ipc::InvokeBody::Json(serde_json::json!({"url":"https://control.example/preview/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/index.html?cap=abc.def.ghi"})),headers:Default::default(),invoke_key:tauri::test::INVOKE_KEY.into()});
        let local=if cfg!(windows){"http://tauri.localhost"}else{"tauri://localhost"};
        assert!(invoke(&main,local).is_ok());
        assert!(invoke(&other,local).unwrap_err().as_str().is_some_and(|s|s.contains("not allowed")));
        assert!(invoke(&main,"https://control.example").is_err());
    }
}
