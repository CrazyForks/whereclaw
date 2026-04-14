fn main() {
    println!("cargo:rerun-if-env-changed=WHERECLAW_BUILD_VARIANT");
    let build_variant = std::env::var("WHERECLAW_BUILD_VARIANT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| String::from("local"));
    println!("cargo:rustc-env=WHERECLAW_BUILD_VARIANT_COMPILED={build_variant}");
    tauri_build::build()
}
