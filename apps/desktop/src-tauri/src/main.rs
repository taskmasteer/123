#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    let args:Vec<_>=std::env::args().skip(1).collect();
    if args.first().is_some_and(|arg|arg.starts_with("--package-")) {
        if args.len()!=1{eprintln!("Package diagnostics accept no paths or credentials.");std::process::exit(1);}
        match site_factory_desktop_lib::package_cli(&args[0]){Ok(value)=>println!("{value}"),Err(error)=>{eprintln!("{}",error.message);std::process::exit(1);}}
        return;
    }
    site_factory_desktop_lib::run();
}
