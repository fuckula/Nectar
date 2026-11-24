//! Unicode-aware fuzzy & prefix/suffix/acronym matcher with Russian->English
//! keyboard layout fallback for Nectar Launcher and Start Menu search.

#[derive(Debug, Clone, Default)]
pub struct ParsedQuery {
    pub terms: Vec<QueryTerm>,
    pub excludes: Vec<String>,
}

#[derive(Debug, Clone)]
pub enum TermKind {
    Fuzzy,
    Prefix,
    Suffix,
    Exact,
}

#[derive(Debug, Clone)]
pub struct QueryTerm {
    pub kind: TermKind,
    pub text: String,
}

pub fn parse_query(raw: &str) -> ParsedQuery {
    let mut terms = Vec::new();
    let mut excludes = Vec::new();
    for token in raw.split_whitespace() {
        if let Some(rest) = token.strip_prefix('!') {
            if !rest.is_empty() {
                excludes.push(rest.to_lowercase());
            }
            continue;
        }
        if let Some(rest) = token.strip_prefix('^') {
            if !rest.is_empty() {
                terms.push(QueryTerm {
                    kind: TermKind::Prefix,
                    text: rest.to_lowercase(),
                });
            }
            continue;
        }
        if let Some(rest) = token.strip_prefix('\'') {
            if !rest.is_empty() {
                terms.push(QueryTerm {
                    kind: TermKind::Exact,
                    text: rest.to_lowercase(),
                });
            }
            continue;
        }
        if let Some(rest) = token.strip_suffix('$') {
            if !rest.is_empty() {
                terms.push(QueryTerm {
                    kind: TermKind::Suffix,
                    text: rest.to_lowercase(),
                });
            }
            continue;
        }
        terms.push(QueryTerm {
            kind: TermKind::Fuzzy,
            text: token.to_lowercase(),
        });
    }
    ParsedQuery {
        terms,
        excludes,
    }
}

/// Maps Russian ЙЦУКЕН characters to English QWERTY keys when a user types a command
/// or Latin app name in the wrong keyboard layout.
pub fn ru_to_en_layout(input: &str) -> Option<String> {
    let mut changed = false;
    let mapped: String = input
        .chars()
        .map(|ch| {
            let out = match ch {
                'й' => 'q', 'ц' => 'w', 'у' => 'e', 'к' => 'r', 'е' => 't', 'н' => 'y',
                'г' => 'u', 'ш' => 'i', 'щ' => 'o', 'з' => 'p', 'х' => '[', 'ъ' => ']',
                'ф' => 'a', 'ы' => 's', 'в' => 'd', 'а' => 'f', 'п' => 'g', 'р' => 'h',
                'о' => 'j', 'л' => 'k', 'д' => 'l', 'ж' => ';', 'э' => '\'',
                'я' => 'z', 'ч' => 'x', 'с' => 'c', 'м' => 'v', 'и' => 'b', 'т' => 'n',
                'ь' => 'm', 'б' => ',', 'ю' => '.',
                'Й' => 'Q', 'Ц' => 'W', 'У' => 'E', 'К' => 'R', 'Е' => 'T', 'Н' => 'Y',
                'Г' => 'U', 'Ш' => 'I', 'Щ' => 'O', 'З' => 'P', 'Х' => '{', 'Ъ' => '}',
                'Ф' => 'A', 'Ы' => 'S', 'В' => 'D', 'А' => 'F', 'П' => 'G', 'Р' => 'H',
                'О' => 'J', 'Л' => 'K', 'Д' => 'L', 'Ж' => ':', 'Э' => '"',
                'Я' => 'Z', 'Ч' => 'X', 'С' => 'C', 'М' => 'V', 'И' => 'B', 'Т' => 'N',
                'Ь' => 'M', 'Б' => '<', 'Ю' => '>',
                _ => return ch,
            };
            changed = true;
            out
        })
        .collect();
    changed.then_some(mapped)
}

/// Maps Cyrillic phonetics to Latin characters so intuitive abbreviations like `тг` match `Telegram`.
pub fn ru_translit_to_en(input: &str) -> Option<String> {
    let mut changed = false;
    let mut out = String::with_capacity(input.len() * 2);
    for ch in input.chars() {
        let rep = match ch.to_lowercase().next().unwrap_or(ch) {
            'а' => "a", 'б' => "b", 'в' => "v", 'г' => "g", 'д' => "d", 'е' | 'ё' => "e",
            'ж' => "zh", 'з' => "z", 'и' | 'й' => "i", 'к' => "k", 'л' => "l", 'м' => "m",
            'н' => "n", 'о' => "o", 'п' => "p", 'р' => "r", 'с' => "s", 'т' => "t",
            'у' => "u", 'ф' => "f", 'х' => "h", 'ц' => "c", 'ч' => "ch", 'ш' => "sh",
            'щ' => "sch", 'ы' => "y", 'э' => "e", 'ю' => "yu", 'я' => "ya",
            'ъ' | 'ь' => "",
            _ => {
                out.push(ch);
                continue;
            }
        };
        changed = true;
        out.push_str(rep);
    }
    changed.then_some(out)
}

fn is_word_start(chars: &[char], idx: usize) -> bool {
    if idx == 0 {
        return true;
    }
    let prev = chars[idx - 1];
    let cur = chars[idx];
    !prev.is_alphanumeric() || (prev.is_lowercase() && cur.is_uppercase())
}

fn score_single_term(term: &QueryTerm, target_chars: &[char], target_lower: &[char]) -> Option<(i32, Vec<usize>)> {
    let q_chars: Vec<char> = term.text.chars().collect();
    if q_chars.is_empty() {
        return Some((0, Vec::new()));
    }

    match term.kind {
        TermKind::Prefix => {
            if target_lower.starts_with(&q_chars) {
                let idxs: Vec<usize> = (0..q_chars.len()).collect();
                return Some((8_000 - (target_lower.len() as i32 - q_chars.len() as i32).max(0), idxs));
            }
            None
        }
        TermKind::Suffix => {
            if target_lower.ends_with(&q_chars) {
                let start = target_lower.len() - q_chars.len();
                let idxs: Vec<usize> = (start..target_lower.len()).collect();
                return Some((7_000 - start as i32, idxs));
            }
            None
        }
        TermKind::Exact => {
            if target_lower.len() < q_chars.len() {
                return None;
            }
            for start in 0..=target_lower.len() - q_chars.len() {
                if target_lower[start..start + q_chars.len()] == q_chars[..] {
                    let exact_whole = target_lower.len() == q_chars.len();
                    let score = if exact_whole { 10_000 } else { 7_500 - start as i32 * 8 };
                    return Some((score, (start..start + q_chars.len()).collect()));
                }
            }
            None
        }
        TermKind::Fuzzy => {
            if target_lower == q_chars.as_slice() {
                return Some((10_000, (0..q_chars.len()).collect()));
            }
            if target_lower.starts_with(&q_chars) {
                let bonus = (target_lower.len() as i32 - q_chars.len() as i32).min(200);
                return Some((8_500 - bonus, (0..q_chars.len()).collect()));
            }

            // Acronym / word-initial match (e.g. "vsc" -> "Visual Studio Code")
            let boundary_indices: Vec<usize> = (0..target_chars.len())
                .filter(|&i| is_word_start(target_chars, i))
                .collect();
            if q_chars.len() >= 2 && boundary_indices.len() >= q_chars.len() {
                let mut bi = 0usize;
                let mut acro_matched = Vec::with_capacity(q_chars.len());
                for &qc in &q_chars {
                    while bi < boundary_indices.len() && target_lower[boundary_indices[bi]] != qc {
                        bi += 1;
                    }
                    if bi < boundary_indices.len() {
                        acro_matched.push(boundary_indices[bi]);
                        bi += 1;
                    } else {
                        break;
                    }
                }
                if acro_matched.len() == q_chars.len() {
                    let spread = acro_matched.last().unwrap_or(&0) - acro_matched.first().unwrap_or(&0);
                    return Some((6_800 - spread as i32 * 5, acro_matched));
                }
            }

            // Contiguous substring match
            if target_lower.len() >= q_chars.len() {
                for start in 0..=target_lower.len() - q_chars.len() {
                    if target_lower[start..start + q_chars.len()] == q_chars[..] {
                        let boundary_bonus = if is_word_start(target_chars, start) { 1_200 } else { 0 };
                        let score = 5_200 + boundary_bonus - (start as i32 * 12);
                        return Some((score, (start..start + q_chars.len()).collect()));
                    }
                }
            }

            // Ordered subsequence fuzzy match
            let mut matched = Vec::with_capacity(q_chars.len());
            let mut ti = 0usize;
            for &qc in &q_chars {
                while ti < target_lower.len() && target_lower[ti] != qc {
                    ti += 1;
                }
                if ti >= target_lower.len() {
                    return None;
                }
                matched.push(ti);
                ti += 1;
            }

            let mut score = 2_400i32;
            for (k, &idx) in matched.iter().enumerate() {
                if is_word_start(target_chars, idx) {
                    score += 320;
                }
                if k > 0 && idx == matched[k - 1] + 1 {
                    score += 260;
                } else if k > 0 {
                    score -= ((idx - matched[k - 1]) as i32) * 18;
                }
            }
            score -= (matched[0] as i32) * 12;
            score -= (target_chars.len() as i32).min(80);
            Some((score.max(100), matched))
        }
    }
}

/// Scores `candidate` against `raw_query`. Returns `(score, char_indices_to_highlight)`.
pub fn match_candidate(raw_query: &str, candidate: &str, extra_searchable: Option<&str>) -> Option<(i32, Vec<usize>)> {
    let parsed = parse_query(raw_query);
    if parsed.terms.is_empty() && parsed.excludes.is_empty() {
        return Some((0, Vec::new()));
    }

    let cand_lower_str = candidate.to_lowercase();
    let extra_lower_str = extra_searchable.map(|s| s.to_lowercase()).unwrap_or_default();
    for excl in &parsed.excludes {
        if cand_lower_str.contains(excl) || (!extra_lower_str.is_empty() && extra_lower_str.contains(excl)) {
            return None;
        }
    }

    if parsed.terms.is_empty() {
        return Some((500, Vec::new()));
    }

    if let Some(hit) = score_terms(&parsed.terms, candidate, extra_searchable) {
        return Some(hit);
    }

    // Fallback 1: Russian layout accidentally active while typing English app/tool name
    if let Some(latin_query) = ru_to_en_layout(raw_query) {
        let latin_parsed = parse_query(&latin_query);
        if !latin_parsed.terms.is_empty() {
            if let Some((score, idxs)) = score_terms(&latin_parsed.terms, candidate, extra_searchable) {
                return Some((score - 450, idxs));
            }
        }
    }

    // Fallback 2: Cyrillic phonetic transliteration (e.g. "тг" -> "tg" -> "Telegram Desktop")
    if let Some(translit) = ru_translit_to_en(raw_query) {
        let tr_parsed = parse_query(&translit);
        if !tr_parsed.terms.is_empty() {
            if let Some((score, idxs)) = score_terms(&tr_parsed.terms, candidate, extra_searchable) {
                return Some((score - 550, idxs));
            }
        }
    }

    None
}

fn score_terms(terms: &[QueryTerm], candidate: &str, extra: Option<&str>) -> Option<(i32, Vec<usize>)> {
    let target_chars: Vec<char> = candidate.chars().collect();
    let target_lower: Vec<char> = candidate.to_lowercase().chars().collect();
    let extra_chars: Vec<char> = extra.map(|s| s.chars().collect()).unwrap_or_default();
    let extra_lower: Vec<char> = extra.map(|s| s.to_lowercase().chars().collect()).unwrap_or_default();

    let mut total = 0i32;
    let mut highlight = Vec::new();
    for term in terms {
        if let Some((s, idxs)) = score_single_term(term, &target_chars, &target_lower) {
            total += s;
            highlight.extend(idxs);
        } else if !extra_lower.is_empty() {
            let (s, _) = score_single_term(term, &extra_chars, &extra_lower)?;
            total += (s as f32 * 0.45) as i32;
        } else {
            return None;
        }
    }
    highlight.sort_unstable();
    highlight.dedup();
    Some((total / terms.len() as i32, highlight))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_beats_prefix_beats_acronym_beats_subsequence() {
        let (s_exact, _) = match_candidate("code", "Code", None).unwrap();
        let (s_prefix, _) = match_candidate("code", "Code Insiders", None).unwrap();
        let (s_acro, _) = match_candidate("vsc", "Visual Studio Code", None).unwrap();
        let (s_subseq, _) = match_candidate("vsc", "eVasive Concept", None).unwrap();
        assert!(s_exact > s_prefix);
        assert!(s_prefix > s_acro);
        assert!(s_acro > s_subseq);
    }

    #[test]
    fn operators_work_correctly() {
        assert!(match_candidate("^vis", "Visual Studio Code", None).is_some());
        assert!(match_candidate("^stu", "Visual Studio Code", None).is_none());
        assert!(match_candidate("code$", "Visual Studio Code", None).is_some());
        assert!(match_candidate("vis$", "Visual Studio Code", None).is_none());
        assert!(match_candidate("'studio", "Visual Studio Code", None).is_some());
        assert!(match_candidate("'vsc", "Visual Studio Code", None).is_none());
        assert!(match_candidate("visual !insiders", "Visual Studio Code", None).is_some());
        assert!(match_candidate("visual !code", "Visual Studio Code", None).is_none());
    }

    #[test]
    fn unicode_cyrillic_and_layout_fallback() {
        let (s, idxs) = match_candidate("блок", "Блокнот", None).unwrap();
        assert!(s > 7_000);
        assert_eq!(idxs, vec![0, 1, 2, 3]);

        // "сркщьу" on Russian layout == "chrome" on QWERTY
        let hit = match_candidate("сркщьу", "Google Chrome", None);
        assert!(hit.is_some());

        // "тг" transliterates to "tg" and matches Telegram
        assert!(match_candidate("тг", "Telegram Desktop", None).is_some());
    }
}
