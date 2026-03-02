use tokio::sync::broadcast;
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::Layer;

use crate::ws::ServerMessage;

/// A tracing Layer that forwards events to the CodeFactory log broadcast channel
/// and appends them to /tmp/codefactory.log for `tail -f`.
pub struct LogBroadcastLayer {
    pub log_tx: broadcast::Sender<ServerMessage>,
}

impl<S: Subscriber> Layer<S> for LogBroadcastLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let level = match *event.metadata().level() {
            tracing::Level::ERROR => "error",
            tracing::Level::WARN => "warn",
            tracing::Level::INFO => "info",
            tracing::Level::DEBUG | tracing::Level::TRACE => return,
        };

        let target = event.metadata().target();

        // Only forward WARN and ERROR to the log viewer/file.
        // INFO is too noisy (every WS connect, terminal spawn, etc.)
        if level == "info" {
            return;
        }

        // Extract message via visitor
        let mut message = String::new();
        let mut visitor = MessageVisitor(&mut message);
        event.record(&mut visitor);

        if message.is_empty() {
            return;
        }
        let source = format!("backend/{}", target);

        // Timestamp from SystemTime
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        let total_secs = now.as_secs();
        let secs_of_day = total_secs % 86400;
        let h = secs_of_day / 3600;
        let m = (secs_of_day % 3600) / 60;
        let s = secs_of_day % 60;
        let time_str = format!("{:02}:{:02}:{:02}", h, m, s);
        let timestamp = format!("1970-01-01T{}Z", time_str); // approximate ISO

        // Write to log file
        let line = format!(
            "[{}] [{:5}] [BACKEND] {}\n",
            time_str,
            level.to_uppercase(),
            message
        );
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open("/tmp/codefactory.log")
        {
            let _ = f.write_all(line.as_bytes());
        }

        // Broadcast to WS subscribers
        let _ = self.log_tx.send(ServerMessage::LogEntry {
            level: level.to_string(),
            source,
            message,
            stack: None,
            timestamp,
        });
    }
}

/// Visitor that extracts the "message" field from a tracing Event.
struct MessageVisitor<'a>(&'a mut String);

impl<'a> tracing::field::Visit for MessageVisitor<'a> {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            *self.0 = format!("{:?}", value).trim_matches('"').to_string();
        }
    }

    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if field.name() == "message" {
            *self.0 = value.to_string();
        }
    }
}
