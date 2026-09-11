import { useEffect, useState } from 'react'
import {
  type SimonaAILimits,
  currentLimits,
  statusListeners,
} from './simonaAiLimits.js'

export function useSimonaAiLimits(): SimonaAILimits {
  const [limits, setLimits] = useState<SimonaAILimits>({ ...currentLimits })

  useEffect(() => {
    const listener = (newLimits: SimonaAILimits) => {
      setLimits({ ...newLimits })
    }
    statusListeners.add(listener)

    return () => {
      statusListeners.delete(listener)
    }
  }, [])

  return limits
}
