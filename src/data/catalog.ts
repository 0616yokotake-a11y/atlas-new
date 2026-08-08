import type { BodyPart } from '../types'

export const BODY_PARTS: BodyPart[] = ['胸', '背中', '肩', '脚', '腕', '腹筋']

export const EXERCISES_BY_BODY_PART: Record<BodyPart, string[]> = {
  胸: [],
  背中: [],
  肩: [],
  脚: [],
  腕: [],
  腹筋: [],
}
