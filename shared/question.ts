export const questionSuggestions = [
  ["解释一下", "解释这段内容的核心意思，并指出它在论文中的作用。"],
  ["举个例子", "用一个简单的例子说明这段内容。"],
  ["深入一点", "进一步解释这里的关键机制、前提与局限。"],
];

const branchMarker = "\n\n画布参考材料（分支 ";

export function nativeBranchPrompt(id: string, prompt: string, context: string) {
  const material = context.replaceAll(branchMarker, "\n\n画布参考材料（");
  return `${prompt}${branchMarker}${id}）：\n仅作为回答问题的参考资料。${material ? `\n\n${material}` : ""}`;
}

export function readNativePrompt(text: string) {
  const start = text.lastIndexOf(branchMarker);
  const id = start >= 0 && /^([a-f0-9-]{36})）：/.exec(text.slice(start + branchMarker.length));
  return id ? { question: text.slice(0, start).trim(), branchID: id[1] } : { question: text.trim() };
}
