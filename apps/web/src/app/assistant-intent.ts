import type { DashboardInsightKind, DashboardInsightQuery } from "@shopmate/contracts";

/** Data words alone do not mean the user requested a new visualization. */
export function insightKind(
  prompt: string,
  previous?: DashboardInsightQuery,
): DashboardInsightKind | undefined {
  const explicit = /(?:生成|画|做|制作|给我|展示).{0,20}(?:图|报告)/u.test(prompt);
  if (
    !explicit &&
    /为什么|为何|怎么|如何|吗|是不是|是否|实时|解释|什么意思|含义|口径|来源|准确|更新|同步/u.test(
      prompt,
    )
  )
    return undefined;
  if (/饼图|环形图|占比图|圆饼/u.test(prompt)) return "pie";
  if (/面积图/u.test(prompt)) return "area";
  if (/柱状图|条形图/u.test(prompt)) return "bar";
  if (/折线图|趋势图/u.test(prompt)) return "line";
  if (/生成.{0,8}报告|报告卡/u.test(prompt)) return "report";
  if (previous && /^(?:那|再|请)?(?:改成|改为|换成|只看|只要|换到)/u.test(prompt.trim()))
    return "auto";
  if (
    /(?:各|每个|按).{0,8}(?:门店|店铺|平台|商品|天).{0,12}(?:销售额|销量|订单|趋势|占比|对比)/u.test(
      prompt,
    )
  )
    return "auto";
  return undefined;
}
