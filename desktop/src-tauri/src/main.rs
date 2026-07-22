#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let exit_code = keydex_desktop_lib::run_entrypoint();
    if exit_code != 0 {
        std::process::exit(exit_code);
    }
}
