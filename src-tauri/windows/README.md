# Installer customization

installer.nsi is the standard Tauri CLI 2.12.1 template (Apache-2.0/MIT), from https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.1/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi. The only modification calls CopyloomCloseRunningApp before invoking the previous NSIS uninstaller. Preserve that insertion when updating the upstream template. hooks.nsh closes the exact installed executable through Windows Restart Manager before replacement/removal. Tauri retains its usual running-app check as a fallback. Cancelling the wizard before committing installation leaves the app running.

The maintenance page is skipped for the same/newer version: UpdateMode is set and installation replaces the executable in place. Downgrades retain the upstream maintenance flow.
