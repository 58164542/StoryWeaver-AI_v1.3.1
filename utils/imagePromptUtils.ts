/**
 * 图片生成提示词工具函数
 *
 * ⚠️ 重要规范：所有图片生成服务（bananaProService、volcengineImageService、
 * xskillImageService 及未来新增的任何服务）在传送提示词给 API 前，
 * 必须调用 buildPromptWithRefs() 将参考图对应关系注入提示词。
 *
 * 原因：若只传图片 URL 而不在文本中说明"图1=角色X、图2=场景Y"，
 * 模型无法知道各参考图对应哪个角色/场景，角色一致性会严重下降。
 */

export interface ReferenceImageMeta {
  name: string;
}

/**
 * 将参考图对应关系注入提示词。
 *
 * 效果示例：
 *   原 prompt: "沈窈站在院门口冷眼旁观"
 *   注入后:    "参考图说明：图1: 沈窈、图2: 东跨院。请严格参照以上参考图中的角色/场景外观。\n\n沈窈站在院门口冷眼旁观"
 *
 * @param prompt        原始提示词
 * @param refImages     参考图元数据数组（只需 name 字段，顺序与实际传给 API 的图片数组一致）
 * @returns             注入了参考图说明的完整提示词
 */
export const buildPromptWithRefs = (
  prompt: string,
  refImages: ReferenceImageMeta[]
): string => {
  if (refImages.length === 0) return prompt;
  const refDesc = refImages.map((img, i) => `图${i + 1}: ${img.name}`).join('、');
  return `参考图说明：${refDesc}。请严格参照以上参考图中的角色/场景外观。\n\n${prompt}`;
};
