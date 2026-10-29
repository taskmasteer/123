#[cfg(target_os = "macos")]
mod macos;
fn main() {
    #[cfg(target_os = "macos")]
    if let Err(error) = macos::run() {
        eprintln!("Runtime ownership unavailable: {error}");
        std::process::exit(1);
    }
    #[cfg(not(target_os = "macos"))]
    {
        eprintln!("The packaged ownership helper requires macOS14+.");
        std::process::exit(1);
    }
}
