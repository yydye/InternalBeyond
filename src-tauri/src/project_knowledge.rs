use std::{
    cmp::Ordering,
    fs,
    path::{Path, PathBuf},
    sync::RwLock,
};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MAX_DOCS: usize = 512;
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_SEARCH_RESULTS: usize = 8;
const MAX_SNIPPET_CHARS: usize = 420;
const MAX_READ_CHARS: usize = 32_000;
const DENY_SEGMENTS: &[&str] = &[
    ".git",
    "node_modules",
    ".venv",
    ".venv-vision",
    "__pycache__",
    "credentials",
    ".env",
    "logs",
    "database",
    "databases",
    "backup",
    "backups",
    "user uploads",
    "uploads",
    "browser-data",
    "dist",
    "target",
];

#[derive(Clone)]
struct Section {
    id: String,
    heading: String,
    level: u8,
    start_line: usize,
    end_line: usize,
    text: String,
}

#[derive(Clone)]
struct IndexedDoc {
    doc_id: String,
    relative_path: String,
    title: String,
    authority: String,
    updated_at: String,
    hash: String,
    absolute: PathBuf,
    sections: Vec<Section>,
}

struct IndexState {
    docs: Vec<IndexedDoc>,
    refreshed_at: Option<String>,
    error: Option<String>,
}

pub struct ProjectKnowledgeState {
    root: PathBuf,
    index: RwLock<IndexState>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectKnowledgeStatus {
    pub ok: bool,
    pub indexed_docs: usize,
    pub canonical_docs: usize,
    pub current_docs: usize,
    pub historical_docs: usize,
    pub last_index_refresh: Option<String>,
    pub search_status: String,
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HeadingSummary {
    id: String,
    title: String,
    level: u8,
    line: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SectionSummary {
    id: String,
    heading: String,
    level: u8,
    start_line: usize,
    end_line: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectDocSummary {
    doc_id: String,
    relative_path: String,
    title: String,
    headings: Vec<HeadingSummary>,
    sections: Vec<SectionSummary>,
    authority: String,
    updated_at: String,
    hash: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDocListResponse {
    #[serde(flatten)]
    status: ProjectKnowledgeStatus,
    docs: Vec<ProjectDocSummary>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchResult {
    doc_id: String,
    relative_path: String,
    title: String,
    section: String,
    heading: String,
    snippet: String,
    authority: String,
    updated_at: String,
    hash: String,
    score: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchStats {
    candidate_count: usize,
    returned: usize,
    terms: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSearchResponse {
    #[serde(flatten)]
    status: ProjectKnowledgeStatus,
    query: String,
    results: Vec<SearchResult>,
    stats: SearchStats,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchArgs {
    pub query: String,
    pub limit: Option<usize>,
    pub authority: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadArgs {
    pub doc_id: String,
    pub section: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDocReadResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relative_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authority: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

impl ProjectKnowledgeState {
    pub fn new(root: PathBuf) -> Self {
        let root = fs::canonicalize(&root).unwrap_or(root);
        Self {
            index: RwLock::new(build_index(&root)),
            root,
        }
    }

    pub fn refresh(&self) {
        let next = build_index(&self.root);
        if let Ok(mut current) = self.index.write() {
            *current = next;
        }
    }

    pub fn status(&self) -> ProjectKnowledgeStatus {
        match self.index.read() {
            Ok(index) => status_from(&index),
            Err(_) => error_status("project-knowledge-lock-poisoned"),
        }
    }

    pub fn list(&self) -> ProjectDocListResponse {
        match self.index.read() {
            Ok(index) => ProjectDocListResponse {
                status: status_from(&index),
                docs: index.docs.iter().map(public_doc).collect(),
            },
            Err(_) => ProjectDocListResponse {
                status: error_status("project-knowledge-lock-poisoned"),
                docs: Vec::new(),
            },
        }
    }

    pub fn search(&self, args: SearchArgs) -> ProjectSearchResponse {
        let query = compact(&args.query).chars().take(240).collect::<String>();
        let terms = terms_of(&query);
        let limit = match args.limit {
            Some(0) | None => MAX_SEARCH_RESULTS,
            Some(value) => value.clamp(1, MAX_SEARCH_RESULTS),
        };
        let authority = args
            .authority
            .unwrap_or_default()
            .trim()
            .to_ascii_uppercase();

        let index = match self.index.read() {
            Ok(index) => index,
            Err(_) => {
                return ProjectSearchResponse {
                    status: error_status("project-knowledge-lock-poisoned"),
                    query,
                    results: Vec::new(),
                    stats: SearchStats {
                        candidate_count: 0,
                        returned: 0,
                        terms,
                    },
                }
            }
        };

        let mut candidates: Vec<(f64, String, String, SearchResult)> = Vec::new();
        for doc in &index.docs {
            if !authority.is_empty() && doc.authority != authority {
                continue;
            }
            for section in &doc.sections {
                let score = score_section(doc, section, &query, &terms);
                if score <= 0.0 {
                    continue;
                }
                candidates.push((
                    score,
                    doc.authority.clone(),
                    doc.updated_at.clone(),
                    SearchResult {
                        doc_id: doc.doc_id.clone(),
                        relative_path: doc.relative_path.clone(),
                        title: doc.title.clone(),
                        section: if section.heading.is_empty() {
                            section.id.clone()
                        } else {
                            section.heading.clone()
                        },
                        heading: section.heading.clone(),
                        snippet: snippet_for(
                            if section.text.is_empty() {
                                &doc.title
                            } else {
                                &section.text
                            },
                            &terms,
                        ),
                        authority: doc.authority.clone(),
                        updated_at: doc.updated_at.clone(),
                        hash: doc.hash.clone(),
                        score,
                    },
                ));
            }
        }

        candidates.sort_by(|a, b| {
            b.0.partial_cmp(&a.0)
                .unwrap_or(Ordering::Equal)
                .then_with(|| authority_rank(&b.1).cmp(&authority_rank(&a.1)))
                .then_with(|| b.2.cmp(&a.2))
                .then_with(|| a.3.doc_id.cmp(&b.3.doc_id))
                .then_with(|| a.3.section.cmp(&b.3.section))
        });

        let candidate_count = candidates.len();
        let mut seen = std::collections::HashSet::new();
        let mut results = Vec::new();
        for (_, _, _, result) in candidates {
            let key = format!("{}|{}", result.doc_id, result.section);
            if !seen.insert(key) {
                continue;
            }
            results.push(result);
            if results.len() >= limit {
                break;
            }
        }
        let returned = results.len();

        ProjectSearchResponse {
            status: status_from(&index),
            query,
            results,
            stats: SearchStats {
                candidate_count,
                returned,
                terms,
            },
        }
    }

    pub fn read_doc(&self, args: ReadArgs) -> ProjectDocReadResponse {
        let doc_id = args.doc_id.trim().to_string();
        let mut doc = match self.find_doc(&doc_id) {
            Some(doc) => doc,
            None => return read_error("doc-not-allowlisted", Some(doc_id)),
        };

        let canonical = match canonical_inside(&self.root, &doc.absolute) {
            Some(path) if path == doc.absolute => path,
            _ => return read_error("path-boundary-rejected", Some(doc_id)),
        };
        let mut content = match fs::read_to_string(&canonical) {
            Ok(content) => content,
            Err(_) => return read_error("doc-unreadable", Some(doc_id)),
        };

        if sha256(&content) != doc.hash {
            self.refresh();
            doc = match self.find_doc(&doc_id) {
                Some(doc) => doc,
                None => return read_error("doc-not-allowlisted", Some(doc_id)),
            };
            content = match fs::read_to_string(&doc.absolute) {
                Ok(content) => content,
                Err(_) => return read_error("doc-unreadable", Some(doc_id)),
            };
            if sha256(&content) != doc.hash {
                return read_error("doc-changed-during-read", Some(doc_id));
            }
        }

        let target = args.section.as_deref().and_then(|requested| {
            let wanted = requested.trim().to_ascii_lowercase();
            doc.sections.iter().find(|section| {
                section.id.to_ascii_lowercase() == wanted
                    || section.heading.to_ascii_lowercase() == wanted
                    || slug(&section.heading) == wanted
            })
        });
        if args.section.is_some() && target.is_none() {
            return read_error("section-not-found", Some(doc_id));
        }

        let body = target
            .map(|section| section.text.as_str())
            .unwrap_or(&content);
        let bounded = take_chars(body, MAX_READ_CHARS);
        ProjectDocReadResponse {
            ok: true,
            error: None,
            doc_id: Some(doc.doc_id),
            relative_path: Some(doc.relative_path),
            title: Some(doc.title),
            section: target.map(|section| {
                if section.heading.is_empty() {
                    section.id.clone()
                } else {
                    section.heading.clone()
                }
            }),
            authority: Some(doc.authority),
            updated_at: Some(doc.updated_at),
            hash: Some(doc.hash),
            truncated: Some(bounded.chars().count() < body.chars().count()),
            content: Some(bounded),
        }
    }

    fn find_doc(&self, doc_id: &str) -> Option<IndexedDoc> {
        self.index
            .read()
            .ok()
            .and_then(|index| index.docs.iter().find(|doc| doc.doc_id == doc_id).cloned())
    }
}

#[tauri::command]
pub fn list_project_docs(state: tauri::State<'_, ProjectKnowledgeState>) -> ProjectDocListResponse {
    state.list()
}

#[tauri::command(rename_all = "camelCase")]
pub fn search_project_docs(
    state: tauri::State<'_, ProjectKnowledgeState>,
    query: String,
    limit: Option<usize>,
    authority: Option<String>,
) -> ProjectSearchResponse {
    state.search(SearchArgs {
        query,
        limit,
        authority,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn read_project_doc(
    state: tauri::State<'_, ProjectKnowledgeState>,
    doc_id: String,
    section: Option<String>,
) -> ProjectDocReadResponse {
    state.read_doc(ReadArgs { doc_id, section })
}

#[tauri::command]
pub fn project_knowledge_status(
    state: tauri::State<'_, ProjectKnowledgeState>,
) -> ProjectKnowledgeStatus {
    state.status()
}

fn build_index(root: &Path) -> IndexState {
    let mut files = Vec::new();
    let mut error = None;
    collect_files(root, root, "", &mut files, &mut error);
    files.sort_by(|a, b| a.0.cmp(&b.0));

    let mut docs = Vec::new();
    for (relative_path, absolute) in files.into_iter().take(MAX_DOCS) {
        let content = match fs::read_to_string(&absolute) {
            Ok(content) => content,
            Err(_) => continue,
        };
        let metadata = match fs::metadata(&absolute) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        let sections = build_sections(&content);
        docs.push(IndexedDoc {
            doc_id: format!("project-doc:{}", relative_path),
            title: title_for(&relative_path, &sections),
            authority: authority_for(&relative_path).to_string(),
            updated_at: updated_at(&metadata),
            hash: sha256(&content),
            absolute,
            relative_path,
            sections,
        });
    }

    IndexState {
        docs,
        refreshed_at: Some(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)),
        error,
    }
}

fn collect_files(
    root: &Path,
    dir: &Path,
    rel_dir: &str,
    out: &mut Vec<(String, PathBuf)>,
    error: &mut Option<String>,
) {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) => {
            if error.is_none() {
                *error = Some(err.to_string());
            }
            return;
        }
    };

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if file_type.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let relative = if rel_dir.is_empty() {
            name
        } else {
            format!("{}/{}", rel_dir, name)
        };
        let relative = normalize_relative(&relative);
        if is_denied_relative(&relative) {
            continue;
        }
        let absolute = entry.path();
        if file_type.is_dir() {
            let lower = relative.to_ascii_lowercase();
            if lower == "docs" || lower.starts_with("docs/") {
                collect_files(root, &absolute, &relative, out, error);
            }
            continue;
        }
        if !file_type.is_file() || !is_allowlisted_relative(&relative) || out.len() >= MAX_DOCS {
            continue;
        }
        let canonical = match canonical_inside(root, &absolute) {
            Some(path) => path,
            None => continue,
        };
        let metadata = match fs::metadata(&canonical) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if metadata.len() > MAX_FILE_BYTES {
            continue;
        }
        out.push((relative, canonical));
    }
}

fn public_doc(doc: &IndexedDoc) -> ProjectDocSummary {
    ProjectDocSummary {
        doc_id: doc.doc_id.clone(),
        relative_path: doc.relative_path.clone(),
        title: doc.title.clone(),
        headings: doc
            .sections
            .iter()
            .filter(|section| !section.heading.is_empty())
            .map(|section| HeadingSummary {
                id: section.id.clone(),
                title: section.heading.clone(),
                level: section.level,
                line: section.start_line,
            })
            .collect(),
        sections: doc
            .sections
            .iter()
            .map(|section| SectionSummary {
                id: section.id.clone(),
                heading: section.heading.clone(),
                level: section.level,
                start_line: section.start_line,
                end_line: section.end_line,
            })
            .collect(),
        authority: doc.authority.clone(),
        updated_at: doc.updated_at.clone(),
        hash: doc.hash.clone(),
    }
}

fn status_from(index: &IndexState) -> ProjectKnowledgeStatus {
    let canonical_docs = index
        .docs
        .iter()
        .filter(|doc| doc.authority == "CANONICAL")
        .count();
    let current_docs = index
        .docs
        .iter()
        .filter(|doc| doc.authority == "CURRENT")
        .count();
    let historical_docs = index
        .docs
        .iter()
        .filter(|doc| doc.authority == "HISTORICAL")
        .count();
    ProjectKnowledgeStatus {
        ok: index.error.is_none(),
        indexed_docs: index.docs.len(),
        canonical_docs,
        current_docs,
        historical_docs,
        last_index_refresh: index.refreshed_at.clone(),
        search_status: if index.error.is_some() {
            "error".to_string()
        } else {
            "ready".to_string()
        },
        error: index.error.clone(),
    }
}

fn error_status(message: &str) -> ProjectKnowledgeStatus {
    ProjectKnowledgeStatus {
        ok: false,
        indexed_docs: 0,
        canonical_docs: 0,
        current_docs: 0,
        historical_docs: 0,
        last_index_refresh: None,
        search_status: "error".to_string(),
        error: Some(message.to_string()),
    }
}

fn read_error(error: &str, doc_id: Option<String>) -> ProjectDocReadResponse {
    ProjectDocReadResponse {
        ok: false,
        error: Some(error.to_string()),
        doc_id,
        relative_path: None,
        title: None,
        section: None,
        authority: None,
        updated_at: None,
        hash: None,
        truncated: None,
        content: None,
    }
}

fn normalize_relative(value: &str) -> String {
    value
        .replace('\\', "/")
        .trim_matches('/')
        .replace("//", "/")
}

fn is_inside(root: &Path, candidate: &Path) -> bool {
    candidate == root || candidate.starts_with(root)
}

fn canonical_inside(root: &Path, candidate: &Path) -> Option<PathBuf> {
    let real = fs::canonicalize(candidate).ok()?;
    if is_inside(root, &real) {
        Some(real)
    } else {
        None
    }
}

fn is_denied_relative(relative: &str) -> bool {
    relative
        .split('/')
        .filter(|part| !part.is_empty())
        .any(|part| {
            let lower = part.to_ascii_lowercase();
            part == "."
                || part == ".."
                || part.starts_with('.')
                || DENY_SEGMENTS.iter().any(|denied| *denied == lower)
        })
}

fn is_allowlisted_relative(relative: &str) -> bool {
    if relative.is_empty() || is_denied_relative(relative) {
        return false;
    }
    let lower = relative.to_ascii_lowercase();
    if !(lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".txt")) {
        return false;
    }
    if lower.starts_with("docs/") {
        return true;
    }
    if relative.contains('/') {
        return false;
    }
    let stem = relative
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(relative)
        .to_ascii_lowercase();
    stem == "readme" || stem.starts_with("readme") || stem == "guide" || stem.starts_with("guide")
}

fn authority_for(relative: &str) -> &'static str {
    let lower = relative.to_ascii_lowercase();
    let canonical = lower
        .split('/')
        .any(|part| part == "contract" || part == "contracts" || part == "canonical")
        || lower.contains("contract")
        || lower.contains("architecture");
    if canonical {
        return "CANONICAL";
    }
    if [
        "chronicle",
        "changelog",
        "historical",
        "legacy",
        "archive",
        "closure",
        "history",
    ]
    .iter()
    .any(|word| lower.contains(word))
    {
        return "HISTORICAL";
    }
    "CURRENT"
}

fn authority_rank(authority: &str) -> u8 {
    match authority {
        "CANONICAL" => 3,
        "CURRENT" => 2,
        "HISTORICAL" => 1,
        _ => 0,
    }
}

fn updated_at(metadata: &fs::Metadata) -> String {
    metadata
        .modified()
        .ok()
        .map(|time| DateTime::<Utc>::from(time).to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_default()
}

fn sha256(content: &str) -> String {
    let digest = Sha256::digest(content.as_bytes());
    digest.iter().map(|byte| format!("{:02x}", byte)).collect()
}

fn heading_rows(content: &str) -> Vec<(u8, String, usize)> {
    content
        .split('\n')
        .enumerate()
        .filter_map(|(index, line)| {
            let trimmed = line.trim_start();
            let level = trimmed.chars().take_while(|char| *char == '#').count();
            if !(1..=6).contains(&level) {
                return None;
            }
            let rest = trimmed.get(level..)?;
            if !rest.starts_with(' ') && !rest.starts_with('\t') {
                return None;
            }
            let title = rest.trim().trim_end_matches('#').trim();
            if title.is_empty() {
                return None;
            }
            Some((level as u8, take_chars(title, 240), index + 1))
        })
        .collect()
}

fn build_sections(content: &str) -> Vec<Section> {
    let lines = content
        .replace('\r', "")
        .split('\n')
        .map(String::from)
        .collect::<Vec<_>>();
    let rows = heading_rows(content);
    if rows.is_empty() {
        return vec![Section {
            id: "document".to_string(),
            heading: String::new(),
            level: 0,
            start_line: 1,
            end_line: lines.len(),
            text: lines.join("\n").trim().to_string(),
        }];
    }

    let mut sections = Vec::new();
    if rows[0].2 > 1 {
        sections.push(Section {
            id: "preamble".to_string(),
            heading: String::new(),
            level: 0,
            start_line: 1,
            end_line: rows[0].2 - 1,
            text: lines[..rows[0].2 - 1].join("\n").trim().to_string(),
        });
    }
    for (index, (level, heading, line)) in rows.iter().enumerate() {
        let mut end_line = lines.len();
        for next in rows.iter().skip(index + 1) {
            if next.0 <= *level {
                end_line = next.2 - 1;
                break;
            }
        }
        let start_index = (*line).min(lines.len());
        let end_index = end_line.min(lines.len());
        sections.push(Section {
            id: slug(heading),
            heading: heading.clone(),
            level: *level,
            start_line: *line,
            end_line,
            text: lines[start_index..end_index].join("\n").trim().to_string(),
        });
    }
    sections
}

fn title_for(relative: &str, sections: &[Section]) -> String {
    sections
        .iter()
        .find(|section| section.level == 1 && !section.heading.is_empty())
        .map(|section| section.heading.clone())
        .unwrap_or_else(|| {
            Path::new(relative)
                .file_stem()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_else(|| relative.to_string())
        })
}

fn slug(value: &str) -> String {
    let mut result = String::new();
    let mut pending_dash = false;
    for character in value.trim().to_lowercase().chars() {
        if character.is_alphanumeric() {
            if pending_dash && !result.is_empty() {
                result.push('-');
            }
            result.push(character);
            pending_dash = false;
        } else if !result.is_empty() {
            pending_dash = true;
        }
    }
    if result.is_empty() {
        "section".to_string()
    } else {
        result
    }
}

fn compact(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn terms_of(query: &str) -> Vec<String> {
    let lower = compact(query).to_lowercase();
    let mut terms = Vec::new();
    for token in lower.split_whitespace() {
        if token.chars().count() >= 2 && !terms.iter().any(|item| item == token) {
            terms.push(token.to_string());
        }
    }
    let han = lower
        .chars()
        .filter(|character| ('\u{4e00}'..='\u{9fff}').contains(character))
        .collect::<Vec<_>>();
    for index in 0..han.len() {
        for width in [2usize, 3usize] {
            if index + width <= han.len() {
                let term = han[index..index + width].iter().collect::<String>();
                if !terms.iter().any(|item| item == &term) {
                    terms.push(term);
                }
            }
        }
    }
    terms.truncate(24);
    terms
}

fn score_section(doc: &IndexedDoc, section: &Section, query: &str, terms: &[String]) -> f64 {
    let haystack = compact(&format!(
        "{} {} {}",
        doc.title, section.heading, section.text
    ))
    .to_lowercase();
    let query = compact(query).to_lowercase();
    if haystack.is_empty() || query.is_empty() {
        return 0.0;
    }
    let mut score = if haystack.contains(&query) { 10.0 } else { 0.0 };
    for term in terms {
        if haystack.contains(term) {
            score += 1.6;
            if !section.heading.is_empty() && section.heading.to_lowercase().contains(term) {
                score += 3.0;
            }
        }
    }
    score + f64::from(authority_rank(&doc.authority)) * 0.35
}

fn snippet_for(value: &str, terms: &[String]) -> String {
    let normalized = compact(value);
    if normalized.chars().count() <= MAX_SNIPPET_CHARS {
        return normalized;
    }
    let lower = normalized.to_lowercase();
    let start = terms
        .iter()
        .find_map(|term| lower.find(&term.to_lowercase()))
        .map(|byte| normalized[..byte].chars().count().saturating_sub(90))
        .unwrap_or(0);
    let chars = normalized.chars().collect::<Vec<_>>();
    let body = chars
        .iter()
        .skip(start)
        .take(MAX_SNIPPET_CHARS.saturating_sub(if start > 0 { 1 } else { 0 }))
        .collect::<String>();
    let prefix = if start > 0 { "…" } else { "" };
    format!(
        "{}{}{}",
        prefix,
        body,
        if start + body.chars().count() < chars.len() {
            "…"
        } else {
            ""
        }
    )
}

fn take_chars(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}
