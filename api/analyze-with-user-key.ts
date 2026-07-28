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

  const model = 'gpt-4o-mini'
  const systemPrompt =
    'あなたはトレーニングコーチです。返答は日本語で、短く具体的に。必ずJSONのみを返し、形式は {"feedback": string[]} としてください。'
  const userPrompt = `以下のトレーニング履歴を分析し、継続に役立つ提案を3-5件返してください。\n${JSON.stringify(
    body.sessions,
  )}`

  try {
    const openAiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    })

    if (!openAiResponse.ok) {
      const errorText = await openAiResponse.text()
      res.status(502).json({ error: `OpenAI API error: ${errorText}` })
      return
    }

    const completion = (await openAiResponse.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = completion.choices?.[0]?.message?.content
    if (!content) {
      res.status(502).json({ error: 'OpenAIレスポンスが空です。' })
      return
    }

    const parsed = JSON.parse(content) as { feedback?: unknown }
    if (!Array.isArray(parsed.feedback) || parsed.feedback.some((item) => typeof item !== 'string')) {
      res.status(502).json({ error: 'OpenAIレスポンス形式が不正です。' })
      return
    }

    res.status(200).json({ feedback: parsed.feedback })
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'AI分析処理中にエラーが発生しました。',
    })
  }
}
