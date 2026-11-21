export const questionSuggestions = [
  ["解释一下", "解释这段内容的核心意思，并指出它在论文中的作用。"],
  ["举个例子", "用一个简单的例子说明这段内容。"],
  ["深入一点", "进一步解释这里的关键机制、前提与局限。"],
];

const branchMarker = "\n\n画布参考材料（分支 ";
const referenceLabel = "仅作为回答问题的参考资料。";

export function nativeBranchPrompt(id: string, prompt: string, context: string) {
  const material = context.replaceAll(branchMarker, "\n\n画布参考材料（");
  return `${prompt}${branchMarker}${id}）：\n${referenceLabel}${material ? `\n\n${material}` : ""}`;
}

export function readNativePrompt(text: string) {
  const start = text.lastIndexOf(branchMarker);
  const suffix = start < 0 ? "" : text.slice(start + branchMarker.length);
  const match = /^([a-f0-9-]{36})）：\n/.exec(suffix);
  if (match && suffix.startsWith(referenceLabel, match[0].length)) {
    return { question: text.slice(0, start).trim(), branchID: match[1], contextOffset: start };
  }
  return { question: text.trim() };
}
