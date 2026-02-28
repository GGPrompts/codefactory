use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tracing::info;

/// A single profile entry (one terminal slot / "floor").
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub name: String,
    pub command: Option<String>,
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

/// Top-level config stored at `~/.config/codefactory/profiles.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileConfig {
    /// Default working directory for profiles that don't specify one.
    #[serde(default = "default_cwd")]
    pub default_cwd: String,
    /// Ordered list of terminal profiles.
    pub profiles: Vec<Profile>,
}

fn default_cwd() -> String {
    "~".to_string()
}

impl Default for ProfileConfig {
    fn default() -> Self {
        Self {
            default_cwd: "~".to_string(),
            profiles: vec![
                Profile {
                    name: "Shell 1".to_string(),
                    command: None,
                    cwd: Some("~".to_string()),
                    icon: None,
                },
                Profile {
                    name: "Shell 2".to_string(),
                    command: None,
                    cwd: Some("~".to_string()),
                    icon: None,
                },
                Profile {
                    name: "Shell 3".to_string(),
                    command: None,
                    cwd: Some("~".to_string()),
                    icon: None,
                },
            ],
        }
    }
}

/// Expand a leading `~` to `$HOME`.
pub fn expand_tilde(path: &str) -> String {
    if path.starts_with('~') {
        if let Ok(home) = std::env::var("HOME") {
            return path.replacen('~', &home, 1);
        }
    }
    path.to_string()
}

/// Return the path to `~/.config/codefactory/profiles.json`.
pub fn config_path() -> PathBuf {
    let base = std::env::var("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
            PathBuf::from(home).join(".config")
        });
    base.join("codefactory").join("profiles.json")
}

/// Load the profile config from disk.
///
/// If the file or directory does not exist, creates them with sensible defaults
/// and returns the default config.
pub fn load_config() -> Result<ProfileConfig> {
    let path = config_path();

    if path.exists() {
        let content = std::fs::read_to_string(&path)
            .with_context(|| format!("Failed to read config at {}", path.display()))?;
        let config: ProfileConfig = serde_json::from_str(&content)
            .with_context(|| format!("Failed to parse config at {}", path.display()))?;
        info!(path = %path.display(), profiles = config.profiles.len(), "Loaded profile config");
        Ok(config)
    } else {
        info!(path = %path.display(), "Config file not found, creating defaults");
        let config = ProfileConfig::default();
        save_config(&config)?;
        Ok(config)
    }
}

/// Write the profile config to disk, creating parent directories as needed.
pub fn save_config(config: &ProfileConfig) -> Result<()> {
    let path = config_path();

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create config directory {}", parent.display()))?;
    }

    let json = serde_json::to_string_pretty(config)
        .context("Failed to serialize profile config")?;
    std::fs::write(&path, json)
        .with_context(|| format!("Failed to write config to {}", path.display()))?;

    info!(path = %path.display(), "Saved profile config");
    Ok(())
}
