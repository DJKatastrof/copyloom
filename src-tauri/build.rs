fn main() {
    // Windows embeds the ICO in the executable; regenerate it when either icon changes.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    tauri_build::build();
}
