import type { WorkoutSession } from '../types'

type AiFeedbackResponse = {
  feedback: string[]
}

export async function requestAiFeedback(
  sessions: WorkoutSession[],
  userApiKey?: string,
  provider: 'openai' | 'gemini' = 'openai',
): Promise<string[]> {
  const trimmedApiKey = userApiKey?.trim() ?? ''

  if (provider === 'gemini' && !trimmedApiKey) {
    throw new Error('GEMINI_KEY_MISSING')
  }

  if (!userApiKey) {
    // サーバー側キーを使用（OpenAI のみ）
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sessions }),
    })

    if (!response.ok) {
      const errorBody = (await response.json()) as { error?: string }
      throw new Error(errorBody.error ?? 'AI分析の取得に失敗しました。')
    }

    const data = (await response.json()) as AiFeedbackResponse
    if (!Array.isArray(data.feedback)) {
      throw new Error('AI分析レスポンス形式が不正です。')
    }

    return data.feedback
  }

  // ユーザー API キーを使用
  const endpoint = provider === 'gemini' ? '/api/analyze-gemini' : '/api/analyze-with-user-key'
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sessions, apiKey: trimmedApiKey }),
  })

  if (!response.ok) {
    const errorBody = (await response.json()) as { error?: string }
    throw new Error(errorBody.error ?? 'AI分析の取得に失敗しました。')
  }

  const data = (await response.json()) as AiFeedbackResponse
  if (!Array.isArray(data.feedback)) {
    throw new Error('AI分析レスポンス形式が不正です。')
  }

  return data.feedback
}
