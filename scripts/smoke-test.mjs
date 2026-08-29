const endpoints = [
  { name: "Web", url: "http://127.0.0.1:3000/" },
  { name: "API 健康检查", url: "http://127.0.0.1:3001/api/v1/health" },
];

export async function checkEndpoint({ name, url }) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) {
      return `${name} 未就绪：${url} 返回 HTTP ${response.status}`;
    }
    return null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "连接失败";
    return `${name} 未就绪：${url}（${detail}）`;
  }
}

export async function runSmokeTest() {
  const failures = [];
  for (const endpoint of endpoints) {
    const failure = await checkEndpoint(endpoint);
    if (failure) failures.push(failure);
    else console.log(`✓ ${endpoint.name} 已就绪：${endpoint.url}`);
  }

  if (failures.length > 0) {
    console.error("本地冒烟测试失败：");
    failures.forEach((failure) => console.error(`✗ ${failure}`));
    return false;
  }
  console.log("本地冒烟测试通过。");
  return true;
}

if (import.meta.main) {
  const passed = await runSmokeTest();
  process.exitCode = passed ? 0 : 1;
}
