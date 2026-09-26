//! Turning raw first prompts into short, readable session titles.

use regex::Regex;
use std::sync::OnceLock;

fn tag_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"</?[A-Za-z_][A-Za-z0-9_\-]*(\s[^>]*)?>").unwrap())
}

/// Prompts that are harness noise rather than something the user typed.
pub fn is_noise_prompt(text: &str) -> bool {
    let t = text.trim_start();
    t.is_empty()
        || t.starts_with("<command-")
        || t.starts_with("<local-command")
        || t.starts_with("<system-reminder")
        || t.starts_with("Caveat:")
        || t.starts_with("[Request interrupted")
        || t.starts_with("<bash-")
        || t.starts_with("<task-notification")
}

/// First meaningful line of a prompt, without markup, at most `max` characters.
pub fn title_from_prompt(text: &str, max: usize) -> Option<String> {
    let stripped = tag_re().replace_all(text, "\n");
    for line in stripped.lines() {
        let line = line
            .trim()
            .trim_start_matches('#')
            .trim()
            .trim_start_matches(['-', '*', '>'])
            .trim();
        if line.len() < 2
            || line.starts_with("```")
            || line.to_lowercase().starts_with("files pasted")
        {
            continue;
        }
        let collapsed = line.split_whitespace().collect::<Vec<_>>().join(" ");
        return Some(truncate(&collapsed, max));
    }
    None
}

pub fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    // Prefer breaking on a word boundary.
    if let Some(i) = out.rfind(' ') {
        if i > max / 2 {
            out.truncate(i);
        }
    }
    out.trim_end_matches([',', '.', ':', ';', ' ']).to_string() + "…"
}

/// A short searchable preview; never the full transcript.
pub fn preview(text: &str) -> String {
    let collapsed = tag_re()
        .replace_all(text, " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    truncate(&collapsed, 200)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_markup_and_headings() {
        let t = "<pasted_content id=\"x\">\n# Files pasted by the user:\n\n## Build the Atlas backup flow\nmore";
        assert_eq!(
            title_from_prompt(t, 60).unwrap(),
            "Build the Atlas backup flow"
        );
    }

    #[test]
    fn truncates_on_word_boundary() {
        let t = title_from_prompt(
            "You are now working on my Atlas Personal OS repository with lots of words",
            30,
        )
        .unwrap();
        assert!(t.ends_with('…'));
        assert!(t.chars().count() <= 30);
        assert!(!t.contains("repositor…"));
    }

    #[test]
    fn detects_noise() {
        assert!(is_noise_prompt("<command-name>/model</command-name>"));
        assert!(is_noise_prompt(
            "<local-command-stdout>x</local-command-stdout>"
        ));
        assert!(!is_noise_prompt("Fix the login bug"));
    }
}
