use crate::commands::AppError;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::{Component, Path};
include!(concat!(env!("OUT_DIR"), "/runtime_anchor.rs"));
pub fn unavailable() -> AppError {
    AppError { code: "NEEDS_ATTENTION".into(), message: "Ресурсы исполнителя отсутствуют или повреждены. Восстановите или переустановите приложение и повторите запрос. Данные сохранены.".into() }
}
fn hash(path: &Path) -> Result<String, AppError> {
    let mut file = std::fs::File::open(path).map_err(|_| unavailable())?;
    let mut digest = Sha256::new();
    let mut bytes = [0u8; 65536];
    loop {
        let n = file.read(&mut bytes).map_err(|_| unavailable())?;
        if n == 0 {
            break;
        }
        digest.update(&bytes[..n]);
    }
    Ok(format!("{:x}", digest.finalize()))
}
fn safe(path: &str) -> bool {
    !path.is_empty()
        && !path.contains('\\')
        && !path.contains(':')
        && !path.chars().any(|c| c.is_control())
        && Path::new(path)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
}
pub fn verify_installed(root: &Path) -> Result<(), AppError> {
    verify(root, MANIFEST_SHA256, PACKAGE_TARGET)
}
pub fn verify(root: &Path, expected: &str, target: &str) -> Result<(), AppError> {
    if expected.len() != 64 || !expected.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(unavailable());
    }
    let root = root.canonicalize().map_err(|_| unavailable())?;
    let manifest = root.join("manifest.json");
    if std::fs::metadata(&manifest)
        .map_err(|_| unavailable())?
        .len()
        > 16 * 1024 * 1024
        || hash(&manifest)? != expected
    {
        return Err(unavailable());
    }
    let value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(manifest).map_err(|_| unavailable())?)
            .map_err(|_| unavailable())?;
    if value["format"] != MANIFEST_FORMAT
        || value["target"] != target
        || value["node"] != "24.21.0"
        || value["playwright"] != "1.64.1"
        || value["chromiumRevision"] != "1248"
        || value["chromiumVersion"] != "156.0.8078.4"
    {
        return Err(unavailable());
    }
    let mut inventory = BTreeMap::new();
    let mut cases = BTreeSet::new();
    for file in value["files"].as_array().ok_or_else(unavailable)? {
        let rel = file["path"].as_str().ok_or_else(unavailable)?;
        if !safe(rel)
            || rel == "manifest.json"
            || !cases.insert(rel.to_lowercase())
            || inventory.insert(rel.to_owned(), file).is_some()
        {
            return Err(unavailable());
        }
    }
    fn walk(
        root: &Path,
        dir: &Path,
        inventory: &mut BTreeMap<String, &serde_json::Value>,
    ) -> Result<(), AppError> {
        for entry in std::fs::read_dir(dir).map_err(|_| unavailable())? {
            let path = entry.map_err(|_| unavailable())?.path();
            let meta = std::fs::symlink_metadata(&path).map_err(|_| unavailable())?;
            let rel = path
                .strip_prefix(root)
                .map_err(|_| unavailable())?
                .to_str()
                .ok_or_else(unavailable)?
                .replace('\\', "/");
            if rel == "manifest.json" {
                continue;
            }
            if meta.file_type().is_symlink() {
                let file = inventory.remove(&rel).ok_or_else(unavailable)?;
                let link = std::fs::read_link(&path).map_err(|_| unavailable())?;
                let actual = path.canonicalize().map_err(|_| unavailable())?;
                if file["type"] != "symlink"
                    || file["link"].as_str() != link.to_str()
                    || !actual.starts_with(root)
                {
                    return Err(unavailable());
                }
            } else if meta.is_dir() {
                walk(root, &path, inventory)?;
            } else if meta.is_file() {
                let file = inventory.remove(&rel).ok_or_else(unavailable)?;
                if file["type"] != "file"
                    || file["size"].as_u64() != Some(meta.len())
                    || file["sha256"].as_str() != Some(hash(&path)?.as_str())
                {
                    return Err(unavailable());
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if file["executable"].as_bool() != Some(meta.permissions().mode() & 0o111 != 0)
                    {
                        return Err(unavailable());
                    }
                }
            } else {
                return Err(unavailable());
            }
        }
        Ok(())
    }
    walk(&root, &root, &mut inventory)?;
    if !inventory.is_empty() {
        return Err(unavailable());
    }
    let node = if target == "win32-x64" {
        "node.exe"
    } else {
        "node"
    };
    for required in [
        node,
        "apps/worker/src/stdio.js",
        "package.json",
        "templates/catalog.json",
        "references/catalog.json",
        "node_modules/playwright/package.json",
        "licenses/runtime-dependencies.json",
    ] {
        if !root.join(required).is_file() {
            return Err(unavailable());
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn adjacent_manifest_replacement_does_not_reanchor_native_launcher() {
        let root = std::env::temp_dir().join(format!(
            "sf-native-anchor-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("manifest.json"), b"changed manifest").unwrap();
        assert!(verify(&root, &"0".repeat(64), "win32-x64").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
