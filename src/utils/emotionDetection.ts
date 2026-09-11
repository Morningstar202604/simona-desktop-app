/**
 * Emotion Detection Module for AI Response Content
 * Analyzes thinking content and final response to detect emotions
 * Returns emotion type and intensity (0-1)
 */

export type EmotionType = 
  | 'happy'          // 开心/喜悦
  | 'excited'        // 兴奋/激动
  | 'confused'       // 困惑/迷茫
  | 'thinking'       // 思考/沉思
  | 'curious'        // 好奇/探索
  | 'surprised'      // 惊讶/意外
  | 'concerned'      // 关心/担忧
  | 'sad'            // 悲伤/同情
  | 'angry'          // 愤怒/不满
  | 'calm'           // 平静/温和
  | 'focused'        // 专注/认真
  | 'playful'        // 调皮/幽默
  | 'empathetic'     // 共情/理解
  | 'neutral'        // 中性/默认
  | 'proud'          // 自豪/满意
  | 'apologetic';    // 抱歉/歉意

export interface EmotionState {
  type: EmotionType;
  intensity: number;  // 0-1
  confidence: number; // 0-1
}

// 情绪关键词映射表
const EMOTION_KEYWORDS: Record<EmotionType, string[]> = {
  happy: [
    'glad', 'happy', 'joy', 'wonderful', 'great', 'awesome', 'excellent',
    'fantastic', 'amazing', 'delightful', 'pleased', 'thrilled', 'cheerful',
    '开心', '高兴', '快乐', '愉快', '太好了', '很棒', '优秀', '精彩',
  ],
  excited: [
    'excited', 'thrilled', 'energized', 'enthusiastic', 'can\'t wait', 'wow',
    'incredible', 'revolutionary', 'breakthrough', 'game-changer',
    '兴奋', '激动', '太棒了', '哇', '不可思议', '突破',
  ],
  confused: [
    'confused', 'unclear', 'ambiguous', 'uncertain', 'not sure', 'puzzled',
    'baffled', 'mystified', 'what do you mean', 'I don\'t understand',
    '困惑', '不确定', '不明白', '什么意思', '不太清楚', '迷茫',
  ],
  thinking: [
    'thinking', 'considering', 'pondering', 'analyzing', 'let me think',
    'I need to consider', 'let me analyze', 'reflecting', 'contemplating',
    '思考', '考虑', '分析', '让我想想', '我需要思考', '沉思',
  ],
  curious: [
    'curious', 'wondering', 'interesting', 'fascinating', 'I wonder',
    'tell me more', 'explore', 'investigate', 'discover',
    '好奇', '有趣', '想知道', '探索', '发现', ' intriguing',
  ],
  surprised: [
    'surprised', 'unexpected', 'didn\'t expect', 'wow', 'really',
    'actually', 'in fact', 'turns out', 'shocking', 'astonishing',
    '惊讶', '没想到', '居然', '真的吗', '意外', '震惊',
  ],
  concerned: [
    'concerned', 'worried', 'careful', 'caution', 'attention',
    'important to note', 'be aware', 'should know', 'potential issue',
    '担心', '注意', '小心', '重要', '需要关注', '潜在问题',
  ],
  sad: [
    'sorry', 'sad', 'unfortunately', 'regret', 'disappointed',
    'painful', 'difficult', 'challenging', 'struggle', 'hardship',
    '抱歉', '难过', '遗憾', '不幸', '痛苦', '困难', '伤心',
  ],
  angry: [
    'frustrated', 'annoyed', 'disappointed', 'unacceptable', 'wrong',
    'incorrect', 'mistake', 'error', 'problem', 'issue',
    '沮丧', '不满', '错误', '问题', ' unacceptable', '生气',
  ],
  calm: [
    'calm', 'peaceful', 'gentle', 'soft', 'quiet', 'serene',
    'take your time', 'no rush', 'relax', 'breathe',
    '平静', '温和', '慢慢来', '不着急', '放松', '安心',
  ],
  focused: [
    'focus', 'concentrate', 'attention', 'detail', 'precise',
    'accurate', 'exact', 'specific', 'carefully', 'methodically',
    '专注', '注意', '细节', '精确', '仔细', '认真', '专注',
  ],
  playful: [
    'fun', 'joke', 'laugh', 'humor', 'playful', 'witty',
    'clever', 'creative', 'imagine', 'what if',
    '有趣', '开玩笑', '哈哈', '幽默', '创意', '想象', '调皮',
  ],
  empathetic: [
    'understand', 'feel', 'emotion', 'empathy', 'compassion',
    'I hear you', 'I understand', 'that must be', 'it sounds like',
    '理解', '感受', '情感', '我明白', '我理解', '共情', '同情',
  ],
  neutral: [],
  proud: [
    'proud', 'accomplished', 'achieved', 'success', 'completed',
    'well done', 'great job', 'impressive', 'remarkable',
    '自豪', '骄傲', '成功', '完成', '做得好', '厉害', '出色',
  ],
  apologetic: [
    'apologize', 'sorry', 'my mistake', 'I apologize', 'forgive me',
    'my bad', 'I was wrong', 'correction', 'let me fix',
    '道歉', '抱歉', '对不起', '我的错', '我错了', '纠正',
  ],
};

// 情绪强度修饰词
const INTENSITY_MODIFIERS = {
  high: ['very', 'extremely', 'really', 'absolutely', 'completely', 'totally', 'incredibly', '非常', '极其', '真的', '完全'],
  medium: ['quite', 'rather', 'somewhat', 'fairly', '比较', '相当', '有些'],
  low: ['a bit', 'slightly', 'a little', 'kind of', '有点', '稍微', '略微'],
};

/**
 * 检测文本中的情绪
 * @param text 要分析的文本（思考内容或回复内容）
 * @returns 情绪状态
 */
export function detectEmotion(text: string): EmotionState {
  if (!text || text.trim().length === 0) {
    return { type: 'neutral', intensity: 0.5, confidence: 0 };
  }

  const lowerText = text.toLowerCase();
  const words = lowerText.split(/\s+/);
  
  let emotionScores: Record<EmotionType, number> = {} as any;
  (Object.keys(EMOTION_KEYWORDS) as EmotionType[]).forEach(emotion => {
    emotionScores[emotion] = 0;
  });

  // 计算每个情绪的得分
  EMOTION_KEYWORDS.happy.forEach(keyword => {
    if (lowerText.includes(keyword.toLowerCase())) {
      emotionScores.happy += getKeywordWeight(keyword);
    }
  });
  EMOTION_KEYWORDS.excited.forEach(keyword => {
    if (lowerText.includes(keyword.toLowerCase())) {
      emotionScores.excited += getKeywordWeight(keyword);
    }
  });
  EMOTION_KEYWORDS.confused.forEach(keyword => {
    if (lowerText.includes(keyword.toLowerCase())) {
      emotionScores.confused += getKeywordWeight(keyword);
    }
  });
  EMOTION_KEYWORDS.thinking.forEach(keyword => {
    if (lowerText.includes(keyword.toLowerCase())) {
      emotionScores.thinking += getKeywordWeight(keyword);
    }
  });
  EMOTION_KEYWORDS.curious.forEach(keyword => {
    if (lowerText.includes(keyword.toLowerCase())) {
      emotionScores.curious += getKeywordWeight(keyword);
    }
  });
  EMOTION_KEYWORDS.surprised.forEach(keyword => {
    if (lowerText.includes(keyword.toLowerCase())) {
      emotionScores.surprised += getKeywordWeight(keyword);
    }
  });
  EMOTION_KEYWORDS.concerned.forEach(keyword => {
    if (lowerText.includes(keyword.toLowerCase())) {
      emotionScores.concerned += getKeywordWeight(keyword);
    }
  });
  EMOTION_KEYWORDS.sad.forEach(keyword => {
    if (lowerText.includes(keyword.toLowerCase())) {
      emotionScores.sad += getKeywordWeight(keyword);
    }
  });
  EMOTION_KEYWORDS.angry.forEach(keyword => {
    if (lowerText.includes(keyword.toLowerCase())) {
      emotionScores.angry += getKeywordWeight(keyword);
    }
  });
  EMOTION_KEYWORDS.calm.forEach(keyword => {
    if (lowerText.includes(keyword.toLowerCase())) {
      emotionScores.calm += getKeywordWeight(keyword);
    }
  });
  EMOTION_KEYWORDS.focused.forEach(keyword => {
    if (lowerText.includes(keyword.toLowerCase())) {
      emotionScores.focused += getKeywordWeight(keyword);
    }
  });
  EMOTION_KEYWORDS.playful.forEach(keyword => {
    if (lowerText.includes(keyword.toLowerCase())) {
      emotionScores.playful += getKeywordWeight(keyword);
    }
  });
  EMOTION_KEYWORDS.empathetic.forEach(keyword => {
    if (lowerText.includes(keyword.toLowerCase())) {
      emotionScores.empathetic += getKeywordWeight(keyword);
    }
  });
  EMOTION_KEYWORDS.proud.forEach(keyword => {
    if (lowerText.includes(keyword.toLowerCase())) {
      emotionScores.proud += getKeywordWeight(keyword);
    }
  });
  EMOTION_KEYWORDS.apologetic.forEach(keyword => {
    if (lowerText.includes(keyword.toLowerCase())) {
      emotionScores.apologetic += getKeywordWeight(keyword);
    }
  });

  // 找出得分最高的情绪
  let maxEmotion: EmotionType = 'neutral';
  let maxScore = 0;

  (Object.keys(emotionScores) as EmotionType[]).forEach(emotion => {
    if (emotion !== 'neutral' && emotionScores[emotion] > maxScore) {
      maxScore = emotionScores[emotion];
      maxEmotion = emotion;
    }
  });

  // 计算强度（基于得分和修饰词）
  let intensity = Math.min(1, maxScore / 5); // 归一化到 0-1
  intensity = applyIntensityModifiers(lowerText, intensity);

  // 计算置信度
  const totalScore = Object.values(emotionScores).reduce((sum, score) => sum + score, 0);
  const confidence = totalScore > 0 ? Math.min(1, maxScore / totalScore) : 0;

  // 如果没有检测到明显情绪，返回中性
  if (maxScore < 1) {
    return { type: 'neutral', intensity: 0.5, confidence: 0.3 };
  }

  return {
    type: maxEmotion,
    intensity: Math.max(0.1, intensity),
    confidence: Math.max(0.1, confidence),
  };
}

/**
 * 获取关键词权重（中文字符权重更高）
 */
function getKeywordWeight(keyword: string): number {
  // 中文关键词权重更高
  if (/[\u4e00-\u9fa5]/.test(keyword)) {
    return 2;
  }
  return 1;
}

/**
 * 应用强度修饰词
 */
function applyIntensityModifiers(text: string, baseIntensity: number): number {
  let multiplier = 1;
  
  INTENSITY_MODIFIERS.high.forEach(word => {
    if (text.includes(word.toLowerCase())) {
      multiplier = Math.max(multiplier, 1.5);
    }
  });
  
  INTENSITY_MODIFIERS.low.forEach(word => {
    if (text.includes(word.toLowerCase())) {
      multiplier = Math.min(multiplier, 0.6);
    }
  });

  return baseIntensity * multiplier;
}

/**
 * 获取情绪对应的颜色
 */
export function getEmotionColor(emotion: EmotionType): string {
  const colors: Record<EmotionType, string> = {
    happy: '#FFB74D',        // 暖橙色
    excited: '#FF5252',      // 亮红色
    confused: '#BA68C8',     // 紫色
    thinking: '#64B5F6',     // 蓝色
    curious: '#4DB6AC',      // 青绿色
    surprised: '#FFD54F',    // 金黄色
    concerned: '#FF8A65',    // 珊瑚色
    sad: '#90A4AE',          // 灰蓝色
    angry: '#EF5350',        // 深红色
    calm: '#81C784',         // 绿色
    focused: '#5C6BC0',      // 蓝色
    playful: '#FFCA28',      // 亮黄色
    empathetic: '#EC407A',   // 粉红色
    neutral: '#B0BEC5',      // 灰色
    proud: '#FFA726',        // 橙色
    apologetic: '#A1887F',   // 棕色
  };
  return colors[emotion] || colors.neutral;
}

/**
 * 获取情绪对应的动画速度
 */
export function getEmotionAnimationSpeed(emotion: EmotionType): number {
  const speeds: Record<EmotionType, number> = {
    happy: 1.2,
    excited: 2.0,
    confused: 0.6,
    thinking: 0.8,
    curious: 1.0,
    surprised: 1.5,
    concerned: 0.7,
    sad: 0.5,
    angry: 1.8,
    calm: 0.4,
    focused: 0.9,
    playful: 1.6,
    empathetic: 0.7,
    neutral: 0.5,
    proud: 1.1,
    apologetic: 0.6,
  };
  return speeds[emotion] || speeds.neutral;
}
