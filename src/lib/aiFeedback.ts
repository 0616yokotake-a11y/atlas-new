import type { WorkoutSession } from '../types'

type AiFeedbackResponse = {
  feedback: string[]
}

export async function requestAiFeedback(sessions: WorkoutSession[], userApiKey?: string): Promise<string[]> {
  const endpoint = userApiKey ? '/api/analyze-with-user-key' : '/api/analyze'
  const body = userApiKey
    ? { sessions, apiKey: userApiKey }
    : { sessions }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
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
