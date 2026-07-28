type ApiRequest = {
  method?: string
  body?: unknown
}

type ApiResponse = {
  status: (statusCode: number) => ApiResponse
  json: (body: unknown) => void
}

type AnalyzeBody = {
  sessions?: unknown
  apiKey?: string
}

function parseBody(body: unknown): AnalyzeBody {
  if (typeof body === 'string') {
    return JSON.parse(body) as AnalyzeBody
  }

  if (body && typeof body === 'object') {
    return body as AnalyzeBody
  }

  return {}
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }

  const body = parseBody(req.body)
  const apiKey = body.apiKey

  if (!apiKey || typeof apiKey !== 'string') {
    res.status(400).json({ error: 'apiKey が不正です。' })
    return
  }

  if (!Array.isArray(body.sessions)) {
    res.status(400).json({ error: 'sessions が不正です。' })
    return
  }

  const systemPrompt =
    'あなたはトレーニングコーチです。返答は日本語で、短く具体的に。必ずJSON形式で返してください。形式: {"feedback": ["提案1", "提案2", ...]}'
  const userPrompt = `以下のトレーニング履歴を分析し、継続に役立つ提案を3-5件返してください。\n${JSON.stringify(
    body.sessions,
  )}`

  try {
    const geminiResponse = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: `${systemPrompt}\n\n${userPrompt}`,
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.4,
            topK: 40,
            topP: 0.95,
            maxOutputTokens: 1024,
          },
        }),
      },
    )

    if (!geminiResponse.ok) {
      const errorText = await geminiResponse.text()
      res.status(502).json({ error: `Google Gemini API error: ${errorText}` })
      return
    }

    const completion = (await geminiResponse.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }
    const text = completion.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) {
      res.status(502).json({ error: 'Gemini レスポンスが空です。' })
      return
    }

    // JSON を抽出（Gemini は JSON のみを返さないことがある）
    const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '')
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      res.status(502).json({ error: 'Gemini レスポンスから JSON を抽出できません。' })
      return
    }

    const parsed = JSON.parse(jsonMatch[0]) as { feedback?: unknown }
    if (!Array.isArray(parsed.feedback) || parsed.feedback.some((item) => typeof item !== 'string')) {
      res.status(502).json({ error: 'Gemini レスポンス形式が不正です。' })
      return
    }

    res.status(200).json({ feedback: parsed.feedback })
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'AI分析処理中にエラーが発生しました。',
    })
  }
}
