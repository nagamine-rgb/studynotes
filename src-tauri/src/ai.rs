//! AIチェック。通信はすべてここで行い、APIキーは画面側に渡さない。
use crate::secrets;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Deserialize)]
pub struct CheckRequest {
    pub provider: String,
    pub model: String,
    pub base_url: Option<String>,
    pub text: String,
    /// "typo"（誤字・表記）または "facts"（内容も確認）
    pub mode: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Issue {
    pub kind: String,
    pub original: String,
    pub suggestion: String,
    #[serde(default)]
    pub reason: String,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Api {
    OpenAiLike,
    Gemini,
    Anthropic,
}

struct Provider {
    api: Api,
    base: String,
    /// OpenAI本家は文章用以外のモデルも一覧に返すので絞り込む
    filter_openai: bool,
    json_mode: bool,
}

fn provider(id: &str, base_url: Option<&str>) -> Result<Provider, String> {
    let custom = base_url.map(|s| s.trim().trim_end_matches('/').to_string()).filter(|s| !s.is_empty());
    let p = match id {
        "openai" => Provider { api: Api::OpenAiLike, base: "https://api.openai.com/v1".into(), filter_openai: true, json_mode: true },
        "deepseek" => Provider { api: Api::OpenAiLike, base: "https://api.deepseek.com".into(), filter_openai: false, json_mode: true },
        "gemini" => Provider { api: Api::Gemini, base: "https://generativelanguage.googleapis.com/v1beta".into(), filter_openai: false, json_mode: true },
        "anthropic" => Provider { api: Api::Anthropic, base: "https://api.anthropic.com/v1".into(), filter_openai: false, json_mode: false },
        "custom" => Provider {
            api: Api::OpenAiLike,
            base: custom.clone().ok_or("カスタム接続先のURLを設定してください")?,
            filter_openai: false,
            json_mode: false,
        },
        _ => return Err(format!("未対応のAIサービスです: {id}")),
    };
    Ok(Provider { base: if id == "custom" { p.base } else { custom.unwrap_or(p.base) }, ..p })
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())
}

const SYSTEM_PROMPT: &str = r#"あなたは学習ノートの校正者です。ユーザーのMarkdownノートを読み、問題点だけをJSONで返します。
出力形式（これ以外は出力しない）:
{"issues":[{"kind":"typo","original":"...","suggestion":"...","reason":"..."}]}
kind: "typo"=誤字・脱字・変換ミス, "style"=表記ゆれ・不自然な表現, "fact"=事実の誤りの疑い
ルール:
- original は本文に実際にある文字列をそのままコピーする。本文中で1か所に決まるよう、必要なら前後の数文字も含める。
- suggestion は original 全体を置き換える文字列（前後の文字を含めた場合はそれも含めて書く）。
- 次の記号は変更・削除・追加しない: ==  [[  ]]  ![[  {{  }}  **  #  |
- reason は日本語で40字以内。
- 問題がなければ {"issues":[]} を返す。最大30件。"#;

fn mode_instruction(mode: &str) -> &'static str {
    if mode == "facts" {
        "誤字・脱字・変換ミス(typo)と表記ゆれ(style)に加え、明らかな事実の誤り（年号・人名・用語の取り違えなど）を kind=\"fact\" として指摘してください。確信が持てないものは指摘しないでください。"
    } else {
        "誤字・脱字・変換ミス(typo)と表記ゆれ・不自然な表現(style)だけを指摘してください。内容の正誤は判断しないでください。"
    }
}

fn user_prompt(req: &CheckRequest) -> String {
    format!("{}\n\n<note>\n{}\n</note>", mode_instruction(&req.mode), req.text)
}

async fn send(rb: reqwest::RequestBuilder) -> Result<Value, String> {
    let res = rb.send().await.map_err(|e| {
        if e.is_timeout() {
            "AIサービスから60秒以内に応答がありませんでした".to_string()
        } else {
            format!("AIサービスに接続できません: {e}")
        }
    })?;
    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let detail: String = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|v| {
                v.pointer("/error/message")
                    .or_else(|| v.pointer("/message"))
                    .and_then(|m| m.as_str().map(|s| s.to_string()))
            })
            .unwrap_or_else(|| body.chars().take(300).collect());
        let hint = match status.as_u16() {
            401 | 403 => "（APIキーを確認してください）",
            404 => "（モデル名や接続先URLを確認してください）",
            429 => "（利用上限に達したか、混み合っています）",
            _ => "",
        };
        return Err(format!("AIサービスのエラー {status}{hint}: {detail}"));
    }
    serde_json::from_str(&body).map_err(|_| "AIサービスの応答を読み取れません".to_string())
}

/// モデルの返答テキストから {"issues":[...]} を取り出す。コードブロックや前置きがあっても読む。
pub fn parse_issues(text: &str) -> Result<Vec<Issue>, String> {
    let start = text.find('{').ok_or("AIの返答に結果が含まれていません")?;
    let end = text.rfind('}').ok_or("AIの返答に結果が含まれていません")?;
    if end < start {
        return Err("AIの返答に結果が含まれていません".into());
    }
    let v: Value = serde_json::from_str(&text[start..=end]).map_err(|_| "AIの返答を読み取れません（JSONの形式が正しくありません）".to_string())?;
    let list = v.get("issues").and_then(|x| x.as_array()).cloned().unwrap_or_default();
    Ok(list
        .into_iter()
        .filter_map(|x| serde_json::from_value::<Issue>(x).ok())
        .filter(|i| !i.original.is_empty() && i.original != i.suggestion)
        .map(|mut i| {
            if !matches!(i.kind.as_str(), "typo" | "style" | "fact") {
                i.kind = "style".into();
            }
            i
        })
        .collect())
}

#[tauri::command]
pub async fn ai_check(req: CheckRequest) -> Result<Vec<Issue>, String> {
    if req.text.trim().is_empty() {
        return Ok(vec![]);
    }
    if req.model.trim().is_empty() {
        return Err("モデルが選ばれていません。設定画面で選んでください".into());
    }
    let p = provider(&req.provider, req.base_url.as_deref())?;
    let key = secrets::get(&req.provider)?;
    let c = client()?;
    let text = match p.api {
        Api::OpenAiLike => {
            let mut body = json!({
                "model": req.model,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_prompt(&req)}
                ]
            });
            if p.json_mode {
                body["response_format"] = json!({"type": "json_object"});
            }
            let v = send(c.post(format!("{}/chat/completions", p.base)).bearer_auth(&key).json(&body)).await?;
            v.pointer("/choices/0/message/content").and_then(|x| x.as_str()).unwrap_or("").to_string()
        }
        Api::Gemini => {
            let body = json!({
                "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
                "contents": [{"role": "user", "parts": [{"text": user_prompt(&req)}]}],
                "generationConfig": {"responseMimeType": "application/json"}
            });
            let url = format!("{}/models/{}:generateContent", p.base, req.model.trim_start_matches("models/"));
            let v = send(c.post(url).header("x-goog-api-key", &key).json(&body)).await?;
            v.pointer("/candidates/0/content/parts")
                .and_then(|x| x.as_array())
                .map(|parts| parts.iter().filter_map(|p| p.get("text").and_then(|t| t.as_str())).collect::<Vec<_>>().join(""))
                .unwrap_or_default()
        }
        Api::Anthropic => {
            let body = json!({
                "model": req.model,
                "max_tokens": 4096,
                "system": SYSTEM_PROMPT,
                "messages": [{"role": "user", "content": user_prompt(&req)}]
            });
            let v = send(
                c.post(format!("{}/messages", p.base))
                    .header("x-api-key", &key)
                    .header("anthropic-version", "2023-06-01")
                    .json(&body),
            )
            .await?;
            v.get("content")
                .and_then(|x| x.as_array())
                .map(|parts| parts.iter().filter_map(|p| p.get("text").and_then(|t| t.as_str())).collect::<Vec<_>>().join(""))
                .unwrap_or_default()
        }
    };
    parse_issues(&text)
}

/// 文章生成に使わないモデルを OpenAI の一覧から除く。
pub fn is_text_model(id: &str) -> bool {
    const SKIP: [&str; 14] = [
        "embedding", "tts", "whisper", "dall-e", "image", "audio", "realtime", "moderation",
        "transcribe", "davinci", "babbage", "sora", "search", "computer-use",
    ];
    let lower = id.to_lowercase();
    !SKIP.iter().any(|s| lower.contains(s))
}

#[tauri::command]
pub async fn ai_list_models(provider_id: String, base_url: Option<String>) -> Result<Vec<String>, String> {
    let p = provider(&provider_id, base_url.as_deref())?;
    let key = secrets::get(&provider_id)?;
    let c = client()?;
    let mut ids: Vec<String> = match p.api {
        Api::OpenAiLike => {
            let v = send(c.get(format!("{}/models", p.base)).bearer_auth(&key)).await?;
            v.get("data")
                .and_then(|x| x.as_array())
                .map(|a| a.iter().filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(String::from)).collect())
                .unwrap_or_default()
        }
        Api::Gemini => {
            let v = send(c.get(format!("{}/models?pageSize=1000", p.base)).header("x-goog-api-key", &key)).await?;
            v.get("models")
                .and_then(|x| x.as_array())
                .map(|a| {
                    a.iter()
                        .filter(|m| {
                            m.get("supportedGenerationMethods")
                                .and_then(|s| s.as_array())
                                .map(|s| s.iter().any(|x| x.as_str() == Some("generateContent")))
                                .unwrap_or(false)
                        })
                        .filter_map(|m| m.get("name").and_then(|n| n.as_str()))
                        .map(|n| n.trim_start_matches("models/").to_string())
                        .filter(|n| is_text_model(n))
                        .collect()
                })
                .unwrap_or_default()
        }
        Api::Anthropic => {
            let v = send(
                c.get(format!("{}/models?limit=1000", p.base))
                    .header("x-api-key", &key)
                    .header("anthropic-version", "2023-06-01"),
            )
            .await?;
            v.get("data")
                .and_then(|x| x.as_array())
                .map(|a| a.iter().filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(String::from)).collect())
                .unwrap_or_default()
        }
    };
    if p.filter_openai {
        ids.retain(|id| is_text_model(id));
    }
    ids.sort();
    ids.dedup();
    if ids.is_empty() {
        return Err("使えるモデルが見つかりませんでした".into());
    }
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_fenced_json() {
        let t = "結果です\n```json\n{\"issues\":[{\"kind\":\"typo\",\"original\":\"見捨てるる\",\"suggestion\":\"見捨てる\",\"reason\":\"重複\"},{\"kind\":\"x\",\"original\":\"a\",\"suggestion\":\"b\"},{\"kind\":\"typo\",\"original\":\"同じ\",\"suggestion\":\"同じ\"}]}\n```";
        let v = parse_issues(t).unwrap();
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].suggestion, "見捨てる");
        assert_eq!(v[1].kind, "style");
    }

    #[test]
    fn empty_and_broken() {
        assert!(parse_issues("{\"issues\":[]}").unwrap().is_empty());
        assert!(parse_issues("no json").is_err());
    }

    #[test]
    fn filters_models() {
        assert!(is_text_model("gpt-5.6-luna"));
        assert!(!is_text_model("text-embedding-3-small"));
        assert!(!is_text_model("gpt-4o-mini-tts"));
    }

    #[test]
    fn provider_bases() {
        assert_eq!(provider("deepseek", None).unwrap().base, "https://api.deepseek.com");
        assert_eq!(provider("openai", Some("https://proxy.example/v1/")).unwrap().base, "https://proxy.example/v1");
        assert!(provider("custom", None).is_err());
        assert_eq!(provider("gemini", None).unwrap().api, Api::Gemini);
    }
}
