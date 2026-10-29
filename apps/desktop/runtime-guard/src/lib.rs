#[cfg(any(target_os = "macos", test))]
pub mod owner_socket;
use serde::{Deserialize, Serialize};
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserRequest {
    pub token: String,
    pub kind: String,
    pub args: Vec<String>,
    pub env: std::collections::BTreeMap<String, String>,
}
pub fn validate(
    request: &BrowserRequest,
    token: &str,
    temp: &std::path::Path,
) -> Result<(), String> {
    if token.len() != 64
        || request.token != token
        || !matches!(request.kind.as_str(), "full" | "headless")
        || request.args.len() > 128
        || request.args.iter().map(|a| a.len()).sum::<usize>() > 32768
    {
        return Err("Invalid private browser request".into());
    }
    let denied = [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-web-security",
        "--no-zygote",
        "--single-process",
        "--remote-debugging-port",
        "--profile-directory",
        "--load-extension",
        "--disable-extensions-except",
        "--proxy-server",
        "--app",
        "--browser-subprocess-path",
        "--renderer-cmd-prefix",
    ];
    let mut profile = false;
    let mut pipe = false;
    for arg in &request.args {
        if arg.chars().any(|c| c.is_control())
            || denied
                .iter()
                .any(|flag| arg == flag || arg.starts_with(&format!("{flag}=")))
        {
            return Err("Unsafe browser override".into());
        }
        if arg == "--remote-debugging-pipe" {
            pipe = true;
        }
        if let Some(value) = arg.strip_prefix("--user-data-dir=") {
            let path = std::path::Path::new(value);
            if !path.is_absolute()
                || !path.starts_with(temp)
                || path == temp
                || path
                    .components()
                    .any(|c| matches!(c, std::path::Component::ParentDir))
            {
                return Err("Unowned browser profile".into());
            }
            profile = true;
        } else if !arg.starts_with("--") && arg != "about:blank" {
            return Err("Unexpected browser argument".into());
        }
    }
    if !profile || !pipe {
        return Err("Missing fixed browser transport/profile".into());
    }
    for (key, value) in &request.env {
        if !["HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL"].contains(&key.as_str())
            || value.len() > 4096
            || value.chars().any(|c| c.is_control())
        {
            return Err("Unexpected browser environment".into());
        }
    }
    Ok(())
}
#[derive(Default)]
pub struct Ownership {
    tracked: bool,
    granted: bool,
    cleaned: bool,
    reaped: bool,
}
impl Ownership {
    pub fn track(&mut self) {
        self.tracked = true;
    }
    pub fn grant(&mut self) -> Result<(), String> {
        if !self.tracked || self.granted || self.cleaned || self.reaped {
            return Err("Cannot grant unowned/stopping child".into());
        }
        self.granted = true;
        Ok(())
    }
    pub fn cleanup(&mut self) -> Result<(), String> {
        if !self.tracked || self.cleaned || self.reaped {
            return Err("Cannot signal stale/unowned child group".into());
        }
        self.cleaned = true;
        Ok(())
    }
    pub fn reap(&mut self) -> Result<(), String> {
        if !self.cleaned || self.reaped {
            return Err("Cleanup must precede reaping".into());
        }
        self.reaped = true;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn owner_failure_before_go_never_releases_an_untracked_child() {
        let mut owned = Ownership::default();
        assert!(owned.grant().is_err());
        owned.track();
        owned.cleanup().unwrap();
        assert!(owned.grant().is_err());
        owned.reap().unwrap();
        assert!(owned.cleanup().is_err());
    }
    #[test]
    fn proxy_or_owner_failure_after_go_requires_group_cleanup_before_reap() {
        let mut owned = Ownership::default();
        owned.track();
        owned.grant().unwrap();
        assert!(owned.reap().is_err());
        owned.cleanup().unwrap();
        owned.reap().unwrap();
        assert!(owned.cleanup().is_err());
    }
    #[test]
    fn fixed_browser_request_rejects_sandbox_and_profile_overrides() {
        let root = std::env::temp_dir();
        let mut request = BrowserRequest {
            token: "t".repeat(64),
            kind: "headless".into(),
            args: vec![
                "--remote-debugging-pipe".into(),
                format!("--user-data-dir={}", root.join("owned-profile").display()),
            ],
            env: Default::default(),
        };
        assert!(validate(&request, &"t".repeat(64), &root).is_ok());
        request.args.push("--no-sandbox".into());
        assert!(validate(&request, &"t".repeat(64), &root).is_err());
        request.args.pop();
        request.args.push("--profile-directory=unowned".into());
        assert!(validate(&request, &"t".repeat(64), &root).is_err());
    }
}
