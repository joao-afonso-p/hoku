//! Maps working directories to projects and derives repository roots.
//!
//! Precedence (see docs/architecture.md):
//!   1. explicit user assignment (project_locked) — handled in db::upsert_discovered
//!   2. existing assignment                       — handled in db::upsert_discovered
//!   3. deepest project root that contains the session's repository or cwd

use crate::models::{Project, ProjectSuggestion};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// `true` when `path` equals `root` or lies underneath it (component-wise, not string prefix).
pub fn is_within(path: &str, root: &str) -> bool {
    let p = Path::new(path);
    let r = Path::new(root);
    p.starts_with(r)
}

/// Strip agent-worktree suffixes such as `/.claude/worktrees/<name>` or `/.codex/worktrees/<name>`.
pub fn strip_agent_worktree(path: &str) -> &str {
    for marker in ["/.claude/worktrees/", "/.codex/worktrees/"] {
        if let Some(i) = path.find(marker) {
            return &path[..i];
        }
    }
    path
}

/// Find the main repository root for a directory. Handles linked git worktrees, whose `.git`
/// is a file pointing at `<main>/.git/worktrees/<name>`. Read-only.
pub fn repository_root(cwd: &str) -> Option<String> {
    let start = PathBuf::from(cwd);
    let mut dir: &Path = start.as_path();
    loop {
        let git = dir.join(".git");
        if git.is_dir() {
            return Some(dir.to_string_lossy().into_owned());
        }
        if git.is_file() {
            if let Ok(content) = std::fs::read_to_string(&git) {
                if let Some(gitdir) = content.trim().strip_prefix("gitdir:") {
                    let gitdir = gitdir.trim();
                    if let Some(i) = gitdir.find("/.git/worktrees/") {
                        return Some(gitdir[..i].to_string());
                    }
                }
            }
            return Some(dir.to_string_lossy().into_owned());
        }
        dir = dir.parent()?;
        if dir == Path::new("/") {
            return None;
        }
    }
}

/// The directory we use to decide project membership.
pub fn anchor_path(cwd: Option<&str>, repository: Option<&str>) -> Option<String> {
    repository
        .map(str::to_string)
        .or_else(|| cwd.map(|c| strip_agent_worktree(c).to_string()))
}

/// Deepest project whose root contains the anchor (or the raw cwd, for worktrees living
/// outside the repo).
pub fn match_project<'a>(
    projects: &'a [Project],
    cwd: Option<&str>,
    repository: Option<&str>,
) -> Option<&'a Project> {
    let candidates: Vec<&str> = [repository, cwd].into_iter().flatten().collect();
    projects
        .iter()
        .filter_map(|p| p.root_path.as_deref().map(|r| (p, r)))
        .filter(|(_, root)| candidates.iter().any(|c| is_within(c, root)))
        .max_by_key(|(_, root)| root.len())
        .map(|(p, _)| p)
}

pub fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".into())
}

/// Turn a path's last component into a readable project name: `personal-website` → `Personal Website`.
pub fn humanize_dir_name(path: &str) -> String {
    let base = Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());
    base.split(|c: char| c == '-' || c == '_' || c == ' ')
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut ch = w.chars();
            match ch.next() {
                Some(f) => f.to_uppercase().collect::<String>() + ch.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Suggest projects for unassigned sessions. Provider-declared projects (e.g. Codex projects)
/// win over inferred repository roots when they cover the same sessions.
pub fn suggest_projects(
    unassigned: &[(Option<String>, Option<String>)],
    provider_hints: &[crate::models::ProjectHint],
    existing: &[Project],
) -> Vec<ProjectSuggestion> {
    let home = home_dir();
    let existing_roots: Vec<&str> = existing
        .iter()
        .filter_map(|p| p.root_path.as_deref())
        .collect();
    let existing_names: Vec<String> = existing.iter().map(|p| p.name.to_lowercase()).collect();
    let mut covered = vec![false; unassigned.len()];
    let mut out: Vec<ProjectSuggestion> = Vec::new();

    for hint in provider_hints {
        if existing_roots.contains(&hint.root_path.as_str())
            || existing_names.contains(&hint.name.to_lowercase())
        {
            continue;
        }
        let mut count = 0;
        for (i, (cwd, repo)) in unassigned.iter().enumerate() {
            let hit = [repo.as_deref(), cwd.as_deref()]
                .into_iter()
                .flatten()
                .any(|p| is_within(p, &hint.root_path));
            if hit && !covered[i] {
                covered[i] = true;
                count += 1;
            }
        }
        if count > 0 {
            out.push(ProjectSuggestion {
                name: hint.name.clone(),
                root_path: hint.root_path.clone(),
                color: hint.color.clone(),
                session_count: count,
                source: hint.source.clone(),
            });
        }
    }

    let mut by_root: BTreeMap<String, usize> = BTreeMap::new();
    for (i, (cwd, repo)) in unassigned.iter().enumerate() {
        if covered[i] {
            continue;
        }
        if let Some(anchor) = anchor_path(cwd.as_deref(), repo.as_deref()) {
            // The home directory and app-support folders are not meaningful projects.
            // Codex's per-chat scratch folders and Downloads are not projects.
            if anchor == home
                || anchor.contains("/Library/")
                || anchor == "/"
                || anchor.contains("/Documents/Codex/")
                || anchor.contains("/Downloads/")
            {
                continue;
            }
            if existing_roots.iter().any(|r| is_within(&anchor, r)) {
                continue;
            }
            *by_root.entry(anchor).or_default() += 1;
        }
    }
    let mut inferred: Vec<ProjectSuggestion> = by_root
        .into_iter()
        .map(|(root, n)| ProjectSuggestion {
            name: humanize_dir_name(&root),
            root_path: root,
            color: None,
            session_count: n,
            source: "working directory".into(),
        })
        .collect();
    inferred.sort_by(|a, b| {
        b.session_count
            .cmp(&a.session_count)
            .then(a.name.cmp(&b.name))
    });
    out.extend(inferred);
    out.sort_by(|a, b| {
        b.session_count
            .cmp(&a.session_count)
            .then(a.name.cmp(&b.name))
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(name: &str, root: &str) -> Project {
        Project {
            id: name.into(),
            name: name.into(),
            root_path: Some(root.into()),
            icon: None,
            color: None,
            slot: 1,
            is_demo: false,
            archived_at: None,
            description: None,
            next_step: None,
            resume_updated_at: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn within_is_component_wise() {
        assert!(is_within("/a/website/src", "/a/website"));
        assert!(is_within("/a/website", "/a/website"));
        assert!(!is_within("/a/website-old", "/a/website"));
    }

    #[test]
    fn deepest_root_wins() {
        let projects = vec![
            p("Evergreen", "/x/Evergreen"),
            p("Backoffice", "/x/Evergreen/Code/backoffice"),
        ];
        let m = match_project(
            &projects,
            Some("/x/Evergreen/Code/backoffice/.claude/worktrees/proj-292"),
            None,
        );
        assert_eq!(m.unwrap().name, "Backoffice");
        let m = match_project(&projects, Some("/x/Evergreen/Code/backend-core"), None);
        assert_eq!(m.unwrap().name, "Evergreen");
        assert!(match_project(&projects, Some("/elsewhere"), None).is_none());
    }

    #[test]
    fn worktree_suffix_is_stripped() {
        assert_eq!(
            strip_agent_worktree("/a/Website/.claude/worktrees/side-quests"),
            "/a/Website"
        );
        assert_eq!(strip_agent_worktree("/a/Website"), "/a/Website");
    }

    #[test]
    fn humanizes_names() {
        assert_eq!(humanize_dir_name("/u/atlas-config"), "Atlas Config");
        assert_eq!(humanize_dir_name("/u/Website"), "Website");
    }

    #[test]
    fn provider_hints_cover_before_inferred_roots() {
        let unassigned = vec![
            (Some("/x/Evergreen/Code/backend-core".to_string()), None),
            (Some("/x/Evergreen/Code/backoffice".to_string()), None),
            (Some("/x/Website".to_string()), None),
        ];
        let hints = vec![crate::models::ProjectHint {
            name: "Evergreen".into(),
            root_path: "/x/Evergreen".into(),
            color: None,
            source: "Codex project".into(),
        }];
        let s = suggest_projects(&unassigned, &hints, &[]);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].name, "Evergreen");
        assert_eq!(s[0].session_count, 2);
        assert_eq!(s[1].root_path, "/x/Website");
    }
}
