//! Safe recursive-descent math, hex/bin, percentage, and unit conversion evaluator.

use std::f64::consts::{E, PI, TAU};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CalcResult {
    pub expression: String,
    pub formatted: String,
    pub raw: String,
    pub note: String,
}

const MAX_DEPTH: usize = 48;

pub fn evaluate(input: &str) -> Option<CalcResult> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    let (forced, body) = if let Some(rest) = trimmed.strip_prefix('=') {
        (true, rest.trim())
    } else {
        (false, trimmed)
    };
    if body.is_empty() {
        return None;
    }

    // Check unit conversion first (`10 km to mi`, `72 f in c`, `512 mb to gb`)
    if let Some(conv) = try_unit_conversion(body) {
        return Some(conv);
    }

    // Check `X% of Y`
    if let Some(pct) = try_percent_of(body) {
        return Some(pct);
    }

    // Guard against matching plain text or single numbers when not prefixed with `=`
    let looks_like_math = forced
        || body.contains('+')
        || body.contains('-')
        || body.contains('*')
        || body.contains('/')
        || body.contains('^')
        || body.contains('%')
        || body.contains('(')
        || body.to_ascii_lowercase().starts_with("0x")
        || body.to_ascii_lowercase().starts_with("0b")
        || body.to_ascii_lowercase().starts_with("0o")
        || matches_math_func(body);

    if !looks_like_math {
        return None;
    }

    let tokens = tokenize(body)?;
    if tokens.is_empty() {
        return None;
    }
    // Single bare integer/float without `=` and without hex/bin prefix shouldn't trigger calc
    if !forced
        && tokens.len() == 1
        && matches!(tokens[0], Tok::Num(_))
        && !body.to_ascii_lowercase().starts_with("0x")
        && !body.to_ascii_lowercase().starts_with("0b")
        && !body.to_ascii_lowercase().starts_with("0o")
    {
        return None;
    }

    let mut parser = Parser { tokens: &tokens, pos: 0 };
    let val = parser.parse_expr(0)?;
    if parser.pos != tokens.len() || !val.is_finite() {
        return None;
    }

    let formatted = format_number(val);
    let note = if body.to_ascii_lowercase().starts_with("0x")
        || body.to_ascii_lowercase().starts_with("0b")
        || body.to_ascii_lowercase().starts_with("0o")
    {
        if val.fract() == 0.0 && val >= 0.0 && val <= (u64::MAX as f64) {
            format!("0x{:X}", val as u64)
        } else {
            "Decimal".to_string()
        }
    } else if val.fract() == 0.0 && val >= 0.0 && val <= 0xFFFF_FFFFu64 as f64 && forced {
        format!("Hex: 0x{:X}", val as u64)
    } else {
        "Calculator — Enter copies result".to_string()
    };

    Some(CalcResult {
        expression: body.to_string(),
        raw: formatted.clone(),
        formatted,
        note,
    })
}

fn matches_math_func(body: &str) -> bool {
    let low = body.to_ascii_lowercase();
    ["sqrt(", "abs(", "sin(", "cos(", "tan(", "asin(", "acos(", "atan(", "log(", "ln(", "exp(", "round(", "floor(", "ceil(", "min(", "max(", "pow("]
        .iter()
        .any(|f| low.starts_with(f))
}

fn try_percent_of(body: &str) -> Option<CalcResult> {
    let low = body.to_ascii_lowercase();
    let idx = low.find("% of ")?;
    let pct_str = body[..idx].trim();
    let base_str = body[idx + 5..].trim();
    let pct = eval_simple(pct_str)?;
    let base = eval_simple(base_str)?;
    let val = (pct / 100.0) * base;
    if !val.is_finite() {
        return None;
    }
    let formatted = format_number(val);
    Some(CalcResult {
        expression: format!("{pct_str}% of {base_str}"),
        raw: formatted.clone(),
        formatted,
        note: "Percentage".to_string(),
    })
}

fn eval_simple(expr: &str) -> Option<f64> {
    let tokens = tokenize(expr)?;
    let mut p = Parser { tokens: &tokens, pos: 0 };
    let val = p.parse_expr(0)?;
    (p.pos == tokens.len() && val.is_finite()).then_some(val)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UnitKind {
    Length,
    Weight,
    Temp,
    Data,
    Time,
}

fn parse_unit(u: &str) -> Option<(UnitKind, f64, &'static str)> {
    Some(match u.to_ascii_lowercase().as_str() {
        "mm" => (UnitKind::Length, 0.001, "mm"),
        "cm" => (UnitKind::Length, 0.01, "cm"),
        "m" => (UnitKind::Length, 1.0, "m"),
        "km" => (UnitKind::Length, 1000.0, "km"),
        "in" | "inch" | "inches" => (UnitKind::Length, 0.0254, "in"),
        "ft" | "foot" | "feet" => (UnitKind::Length, 0.3048, "ft"),
        "yd" | "yard" | "yards" => (UnitKind::Length, 0.9144, "yd"),
        "mi" | "mile" | "miles" => (UnitKind::Length, 1609.344, "mi"),

        "mg" => (UnitKind::Weight, 0.000_001, "mg"),
        "g" => (UnitKind::Weight, 0.001, "g"),
        "kg" => (UnitKind::Weight, 1.0, "kg"),
        "t" | "ton" | "tons" => (UnitKind::Weight, 1000.0, "t"),
        "oz" => (UnitKind::Weight, 0.028_349_523_125, "oz"),
        "lb" | "lbs" => (UnitKind::Weight, 0.453_592_37, "lb"),

        "c" | "°c" | "celsius" => (UnitKind::Temp, 0.0, "°C"),
        "f" | "°f" | "fahrenheit" => (UnitKind::Temp, 1.0, "°F"),
        "k" | "kelvin" => (UnitKind::Temp, 2.0, "K"),

        "b" | "bytes" => (UnitKind::Data, 1.0, "B"),
        "kb" => (UnitKind::Data, 1_000.0, "KB"),
        "mb" => (UnitKind::Data, 1_000_000.0, "MB"),
        "gb" => (UnitKind::Data, 1_000_000_000.0, "GB"),
        "tb" => (UnitKind::Data, 1_000_000_000_000.0, "TB"),
        "kib" => (UnitKind::Data, 1024.0, "KiB"),
        "mib" => (UnitKind::Data, 1024.0 * 1024.0, "MiB"),
        "gib" => (UnitKind::Data, 1024.0 * 1024.0 * 1024.0, "GiB"),
        "tib" => (UnitKind::Data, 1024.0 * 1024.0 * 1024.0 * 1024.0, "TiB"),

        "ms" => (UnitKind::Time, 0.001, "ms"),
        "s" | "sec" => (UnitKind::Time, 1.0, "s"),
        "min" | "mins" => (UnitKind::Time, 60.0, "min"),
        "h" | "hr" | "hrs" => (UnitKind::Time, 3600.0, "h"),
        "d" | "day" | "days" => (UnitKind::Time, 86400.0, "d"),
        _ => return None,
    })
}

fn try_unit_conversion(body: &str) -> Option<CalcResult> {
    let low = body.to_ascii_lowercase();
    let (lhs, rhs) = if let Some(pos) = low.find(" to ") {
        (&body[..pos], &body[pos + 4..])
    } else if let Some(pos) = low.find(" in ") {
        (&body[..pos], &body[pos + 4..])
    } else if let Some(pos) = low.find(" -> ") {
        (&body[..pos], &body[pos + 4..])
    } else {
        return None;
    };

    let (to_kind, to_scale, to_label) = parse_unit(rhs.trim())?;
    let lhs_trim = lhs.trim();
    let split_at = lhs_trim
        .char_indices()
        .rev()
        .find(|(_, ch)| !ch.is_alphabetic() && *ch != '°')
        .map(|(i, ch)| i + ch.len_utf8())?;
    let num_str = lhs_trim[..split_at].trim();
    let unit_str = lhs_trim[split_at..].trim();
    let val = num_str.parse::<f64>().ok()?;
    let (from_kind, from_scale, from_label) = parse_unit(unit_str)?;
    if from_kind != to_kind {
        return None;
    }

    let converted = if from_kind == UnitKind::Temp {
        let celsius = match from_label {
            "°C" => val,
            "°F" => (val - 32.0) * 5.0 / 9.0,
            "K" => val - 273.15,
            _ => return None,
        };
        match to_label {
            "°C" => celsius,
            "°F" => celsius * 9.0 / 5.0 + 32.0,
            "K" => celsius + 273.15,
            _ => return None,
        }
    } else {
        (val * from_scale) / to_scale
    };

    if !converted.is_finite() {
        return None;
    }
    let formatted_num = format_number(converted);
    Some(CalcResult {
        expression: format!("{} {} → {}", format_number(val), from_label, to_label),
        formatted: format!("{formatted_num} {to_label}"),
        raw: formatted_num,
        note: "Unit conversion".to_string(),
    })
}

fn format_number(v: f64) -> String {
    let v = if v.abs() < 1e-12 { 0.0 } else { v };
    if v.fract().abs() < 1e-10 && v.abs() < 1e15 {
        return format!("{}", v.round() as i64);
    }
    let s = format!("{v:.8}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    s.to_string()
}

#[derive(Debug, Clone)]
enum Tok {
    Num(f64),
    Ident(String),
    Plus,
    Minus,
    Mul,
    Div,
    Pow,
    Percent,
    LParen,
    RParen,
    Comma,
}

fn tokenize(input: &str) -> Option<Vec<Tok>> {
    let mut out = Vec::new();
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        match c {
            '+' => { out.push(Tok::Plus); i += 1; }
            '-' => { out.push(Tok::Minus); i += 1; }
            '*' => {
                if i + 1 < chars.len() && chars[i + 1] == '*' {
                    out.push(Tok::Pow);
                    i += 2;
                } else {
                    out.push(Tok::Mul);
                    i += 1;
                }
            }
            '/' => { out.push(Tok::Div); i += 1; }
            '^' => { out.push(Tok::Pow); i += 1; }
            '%' => { out.push(Tok::Percent); i += 1; }
            '(' => { out.push(Tok::LParen); i += 1; }
            ')' => { out.push(Tok::RParen); i += 1; }
            ',' => { out.push(Tok::Comma); i += 1; }
            '0'..='9' | '.' => {
                let start = i;
                if c == '0' && i + 1 < chars.len() && matches!(chars[i + 1], 'x' | 'X' | 'b' | 'B' | 'o' | 'O') {
                    let prefix = chars[i + 1].to_ascii_lowercase();
                    i += 2;
                    let dstart = i;
                    while i < chars.len() && (chars[i].is_ascii_hexdigit() || chars[i] == '_') {
                        i += 1;
                    }
                    let digits: String = chars[dstart..i].iter().filter(|&&ch| ch != '_').collect();
                    let radix = match prefix {
                        'x' => 16,
                        'b' => 2,
                        'o' => 8,
                        _ => return None,
                    };
                    let val = u64::from_str_radix(&digits, radix).ok()? as f64;
                    out.push(Tok::Num(val));
                } else {
                    while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.' || chars[i] == '_') {
                        i += 1;
                    }
                    let num_str: String = chars[start..i].iter().filter(|&&ch| ch != '_').collect();
                    let val = num_str.parse::<f64>().ok()?;
                    out.push(Tok::Num(val));
                }
            }
            _ if c.is_ascii_alphabetic() => {
                let start = i;
                while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
                    i += 1;
                }
                let ident: String = chars[start..i].iter().collect();
                out.push(Tok::Ident(ident.to_ascii_lowercase()));
            }
            _ => return None,
        }
    }
    Some(out)
}

struct Parser<'a> {
    tokens: &'a [Tok],
    pos: usize,
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<&Tok> {
        self.tokens.get(self.pos)
    }

    fn next(&mut self) -> Option<Tok> {
        let t = self.tokens.get(self.pos).cloned()?;
        self.pos += 1;
        Some(t)
    }

    fn parse_expr(&mut self, depth: usize) -> Option<f64> {
        if depth > MAX_DEPTH {
            return None;
        }
        let mut lhs = self.parse_term(depth + 1)?;
        while let Some(tok) = self.peek() {
            match tok {
                Tok::Plus => {
                    self.pos += 1;
                    let is_pct = self.peek_pct_rhs(depth + 1);
                    if let Some(pct_val) = is_pct {
                        lhs += lhs * (pct_val / 100.0);
                    } else {
                        lhs += self.parse_term(depth + 1)?;
                    }
                }
                Tok::Minus => {
                    self.pos += 1;
                    let is_pct = self.peek_pct_rhs(depth + 1);
                    if let Some(pct_val) = is_pct {
                        lhs -= lhs * (pct_val / 100.0);
                    } else {
                        lhs -= self.parse_term(depth + 1)?;
                    }
                }
                _ => break,
            }
        }
        Some(lhs)
    }

    fn peek_pct_rhs(&mut self, depth: usize) -> Option<f64> {
        let saved = self.pos;
        if let Some(Tok::Num(n)) = self.peek().cloned() {
            if matches!(self.tokens.get(saved + 1), Some(Tok::Percent)) {
                let after = self.tokens.get(saved + 2);
                if after.is_none() || matches!(after, Some(Tok::Plus | Tok::Minus | Tok::RParen | Tok::Comma)) {
                    let _ = depth;
                    self.pos = saved + 2;
                    return Some(n);
                }
            }
        }
        None
    }

    fn parse_term(&mut self, depth: usize) -> Option<f64> {
        if depth > MAX_DEPTH {
            return None;
        }
        let mut lhs = self.parse_power(depth + 1)?;
        while let Some(tok) = self.peek() {
            match tok {
                Tok::Mul => {
                    self.pos += 1;
                    lhs *= self.parse_power(depth + 1)?;
                }
                Tok::Div => {
                    self.pos += 1;
                    let rhs = self.parse_power(depth + 1)?;
                    if rhs == 0.0 {
                        return None;
                    }
                    lhs /= rhs;
                }
                Tok::Percent => {
                    // `200 * 15%` -> 15% = 0.15; or `10 % 3` -> modulo if followed by primary
                    let next_starts_expr = matches!(
                        self.tokens.get(self.pos + 1),
                        Some(Tok::Num(_) | Tok::Ident(_) | Tok::LParen | Tok::Minus | Tok::Plus)
                    );
                    if next_starts_expr {
                        self.pos += 1;
                        let rhs = self.parse_power(depth + 1)?;
                        if rhs == 0.0 {
                            return None;
                        }
                        lhs %= rhs;
                    } else {
                        self.pos += 1;
                        lhs /= 100.0;
                    }
                }
                _ => break,
            }
        }
        Some(lhs)
    }

    fn parse_power(&mut self, depth: usize) -> Option<f64> {
        if depth > MAX_DEPTH {
            return None;
        }
        let base = self.parse_unary(depth + 1)?;
        if matches!(self.peek(), Some(Tok::Pow)) {
            self.pos += 1;
            let exp = self.parse_power(depth + 1)?;
            Some(base.powf(exp))
        } else {
            Some(base)
        }
    }

    fn parse_unary(&mut self, depth: usize) -> Option<f64> {
        if depth > MAX_DEPTH {
            return None;
        }
        match self.peek() {
            Some(Tok::Minus) => {
                self.pos += 1;
                Some(-self.parse_unary(depth + 1)?)
            }
            Some(Tok::Plus) => {
                self.pos += 1;
                self.parse_unary(depth + 1)
            }
            _ => self.parse_primary(depth + 1),
        }
    }

    fn parse_primary(&mut self, depth: usize) -> Option<f64> {
        if depth > MAX_DEPTH {
            return None;
        }
        let tok = self.next()?;
        let mut val = match tok {
            Tok::Num(n) => n,
            Tok::LParen => {
                let v = self.parse_expr(depth + 1)?;
                if !matches!(self.next(), Some(Tok::RParen)) {
                    return None;
                }
                v
            }
            Tok::Ident(name) => {
                if matches!(self.peek(), Some(Tok::LParen)) {
                    self.pos += 1;
                    let a = self.parse_expr(depth + 1)?;
                    let b = if matches!(self.peek(), Some(Tok::Comma)) {
                        self.pos += 1;
                        Some(self.parse_expr(depth + 1)?)
                    } else {
                        None
                    };
                    if !matches!(self.next(), Some(Tok::RParen)) {
                        return None;
                    }
                    match (name.as_str(), b) {
                        ("sqrt", None) => a.sqrt(),
                        ("abs", None) => a.abs(),
                        ("sin", None) => a.sin(),
                        ("cos", None) => a.cos(),
                        ("tan", None) => a.tan(),
                        ("asin", None) => a.asin(),
                        ("acos", None) => a.acos(),
                        ("atan", None) => a.atan(),
                        ("log" | "log10", None) => a.log10(),
                        ("ln", None) => a.ln(),
                        ("exp", None) => a.exp(),
                        ("round", None) => a.round(),
                        ("floor", None) => a.floor(),
                        ("ceil", None) => a.ceil(),
                        ("min", Some(b)) => a.min(b),
                        ("max", Some(b)) => a.max(b),
                        ("pow", Some(b)) => a.powf(b),
                        _ => return None,
                    }
                } else {
                    match name.as_str() {
                        "pi" => PI,
                        "e" => E,
                        "tau" => TAU,
                        _ => return None,
                    }
                }
            }
            _ => return None,
        };
        while matches!(self.peek(), Some(Tok::Percent)) {
            let next_starts_expr = matches!(
                self.tokens.get(self.pos + 1),
                Some(Tok::Num(_) | Tok::Ident(_) | Tok::LParen)
            );
            if next_starts_expr {
                break;
            }
            self.pos += 1;
            val /= 100.0;
        }
        Some(val)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evaluates_arithmetic_functions_and_hex() {
        assert_eq!(evaluate("2 + 3 * 4").unwrap().formatted, "14");
        assert_eq!(evaluate("(2 + 3) * 4^2").unwrap().formatted, "80");
        assert_eq!(evaluate("sqrt(144) + max(2, 8)").unwrap().formatted, "20");
        assert_eq!(evaluate("0xff + 0b101").unwrap().formatted, "260");
        assert_eq!(evaluate("200 + 15%").unwrap().formatted, "230");
        assert_eq!(evaluate("15% of 240").unwrap().formatted, "36");
    }

    #[test]
    fn evaluates_unit_conversions() {
        assert_eq!(evaluate("5 km to m").unwrap().formatted, "5000 m");
        assert_eq!(evaluate("32 f in c").unwrap().formatted, "0 °C");
        assert_eq!(evaluate("2 gib to mib").unwrap().formatted, "2048 MiB");
    }

    #[test]
    fn ignores_non_math_queries() {
        assert!(evaluate("chrome").is_none());
        assert!(evaluate("2026").is_none());
        assert_eq!(evaluate("= 2026").unwrap().formatted, "2026");
        assert!(evaluate("10 / 0").is_none());
    }
}
