export type BodyPart = '胸' | '背中' | '肩' | '脚' | '腕' | '腹筋'
export type ExerciseMetricType = 'reps' | 'time'

export type ExerciseSet = {
  id: string
  weight: number
  reps: number
  durationSec?: number
}

export type WorkoutExercise = {
  id: string
  name: string
  metricType?: ExerciseMetricType
  sets: ExerciseSet[]
}

export type WorkoutSession = {
  id: string
  date: string
  bodyPart: BodyPart
  exercises: WorkoutExercise[]
}

export type MyMenu = {
  id: string
  name: string
  bodyPart: BodyPart
  exercises: string[]
}
