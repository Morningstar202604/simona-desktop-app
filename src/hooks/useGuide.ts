import { useState, useEffect } from 'react';

/**
 * 通用引导提示Hook（每次都会显示）
 * @param trigger 触发条件，当为true时显示引导
 * @param autoHideDelay 自动隐藏时间（毫秒），默认5000ms
 * @returns [showGuide, setShowGuide]
 */
export function useGuide(trigger: boolean, autoHideDelay: number = 5000) {
  const [showGuide, setShowGuide] = useState(false);

  useEffect(() => {
    if (trigger) {
      setShowGuide(true);
      
      // 自动隐藏
      const timer = setTimeout(() => {
        setShowGuide(false);
      }, autoHideDelay);

      return () => clearTimeout(timer);
    } else {
      setShowGuide(false);
    }
  }, [trigger, autoHideDelay]);

  const dismissGuide = () => {
    setShowGuide(false);
  };

  return [showGuide, dismissGuide] as const;
}
