/**
 * 抖音Report 的原因分类 —— 与抖音网页端举报表单【逐字一致】(2026-10-17 真机核对)。
 * 纯数据模块,主进程(存盘校验)和渲染层(向导下拉)共用同一份;后端剧本 config.json 里有同一份。
 * 抖音改版改选项时,三处一起改:这里、backend/matrix/scenarios/douyin_report/config.json、(无需改剧本代码)。
 *
 * 「侵犯权益」「搬运、抄袭作品」不在列表里:要另外举证(批量侵权页 / 原创链接 + 截图),自动化不支持。
 * 作品(视频/图文,两种表单选项完全相同):具体类型选填,但「AI生成内容问题」必填;账号:具体类型必填。
 */

export type ReportTargetType = 'content' | 'account';

export interface ReportReasonDef {
  label: string;      // 抖音表单上的原因原文
  sub: string[];      // 该原因下的「具体类型」原文
  hint?: string;      // 抖音描述框 placeholder(选该原因后显示的提示)
  subRequired?: boolean; // 该原因单独要求必选具体类型(覆盖分组默认值)
}

export interface ReportTaxonomyGroup {
  subRequired: boolean;
  reasons: ReportReasonDef[];
}

export const REPORT_TAXONOMY: Record<ReportTargetType, ReportTaxonomyGroup> = {
  content: {
    subRequired: false,
    reasons: [
      { label: '我不喜欢', sub: [], hint: '请详细描述举报原因，便于平台判断违规情况' },
      { label: '引导到站外进行色情、赌博', sub: ['色情服务', '色情资源', '赌博/赌球', '其他引导站外'], hint: '请描述作品中存在的问题，如引导添加外部账号、扫码跳转的方式，或涉及的色情服务、赌博平台信息等' },
      { label: '涉嫌欺诈', sub: ['养老诈骗', '引流欺诈', '情感诈骗', '仿冒欺诈', '财经诈骗', '涉未成年诈骗', '其他诈骗'], hint: '请描述作品中存在的问题，如虚假身份、夸大收益的话术，或引导转账、充值的方式和平台等' },
      { label: '色情低俗', sub: ['色情裸露内容', '未成年低俗'], hint: '请描述存在问题的镜头或内容，如隐私部位暴露' },
      { label: '违法犯罪', sub: ['违禁品', '推广作弊软件', '宣传游戏私服', '其他违规'], hint: '请描述作品中存在的问题，如：涉及哪些受保护的动植物、违法行为或违禁品' },
      { label: '政治敏感', sub: ['涉政不实信息', '涉政不当言论'], hint: '描述作品中存在的问题，如：涉及哪些事件或人物' },
      { label: '违规营销', sub: ['虚假/夸大宣传', '售卖假冒商品', '违规问诊开药'], hint: '请描述作品中存在的问题和具体内容定位，如：X分X秒出现了XX假货、违规广告' },
      { label: '不实信息', sub: ['虚假新闻、谣言', '虚假专业知识', '虚假摆拍演绎', '冒用他人信息', '医疗误导信息', '封建迷信', '画面制作虚假', '其他不实信息'], hint: '描述涉及哪些事件、人物或伪科学内容,以及您知道的正确内容' },
      { label: '网络暴力', sub: ['网暴我', '网暴他人'], hint: '请尽可能详细描述您了解的情况' },
      { label: '危害人身安全', sub: ['危险行为', '自杀/自残'], hint: '请尽可能详细描述您了解的情况' },
      { label: '未成年相关', sub: ['未成年低俗', '未成年不良行为', '色情/恐怖动画', '未成年欺诈'], hint: '请描述存在的问题，如：说脏话、演绎成人动作或传播不良价值观等行为' },
      { label: 'AI生成内容问题', subRequired: true, sub: ['未添加AI标识', '色情低俗', '违法犯罪', '政治敏感', '不实信息', '侵犯权益'], hint: '请描述存在问题的具体画面，及具体画面所涉及的违规信息' },
      { label: '以上没有我想举报的类型', sub: ['引人不适', '血腥/恐怖/暴力', '价值观导向不良', '诱导点赞/关注', '其他'], hint: '请描述让您感到不适或存在不良导向的具体内容' },
    ],
  },
  account: {
    subRequired: true,
    reasons: [
      { label: '内容违规', sub: ['色情低俗', '政治敏感', '不实信息', '违法违规', '侮辱谩骂', '违规营销'] },
      { label: '引导私下交易', sub: ['色情招嫖', '售卖违禁品', '赌博/赌球', '垃圾广告'] },
      { label: '未成年相关', sub: ['未成年低俗', '不良行为', '色情/恐怖动画'] },
      { label: '冒充他人', sub: ['冒充我自己', '冒充名人', '冒充企业', '冒充品牌', '其他类冒充'] },
      { label: '涉嫌欺诈', sub: ['养老诈骗', '引流欺诈', '情感诈骗', '仿冒欺诈', '财经诈骗', '青少年诈骗', '其他诈骗'] },
      { label: '危害人身安全', sub: ['危险行为', '自杀/自残'] },
      { label: '其他', sub: ['MCN机构举报', '其它违规'] },
    ],
  },
};

export const REPORT_DEFAULT_HINT = '请详细描述举报原因，便于平台判断违规情况';

export function findReportReason(type: ReportTargetType, label: string): ReportReasonDef | undefined {
  return REPORT_TAXONOMY[type]?.reasons.find((r) => r.label === label);
}

/** 按链接猜类型:/user/ = 账号;/video/ /note/ modal_id = 作品;短链(v.douyin.com)猜不出 → ''(由用户选)。 */
export function guessReportTargetType(url: string): ReportTargetType | '' {
  const s = String(url || '');
  if (/\/(video|note)\/\d{6,}|modal_id=\d{6,}|\/share\/video\/\d{6,}/i.test(s)) return 'content';
  if (/\/user\/(?!self)[\w-]{6,}/i.test(s)) return 'account';
  return '';
}

/** 单条校验,返回错误码(null = 通过)。主进程存盘与渲染层表单用同一套规则。 */
export function validateReportItem(it: { url?: string; targetType?: string; reason?: string; subReason?: string; description?: string }): string | null {
  const url = String(it.url || '').trim();
  if (!/^https?:\/\/([\w-]+\.)?(douyin|iesdouyin)\.com\//i.test(url)) return 'report_invalid_url';
  const type = it.targetType as ReportTargetType;
  if (type !== 'content' && type !== 'account') return 'report_invalid_target_type';
  const guessed = guessReportTargetType(url);
  if (guessed && guessed !== type) return 'report_target_type_mismatch';
  const def = findReportReason(type, String(it.reason || ''));
  if (!def) return 'report_invalid_reason';
  const sub = String(it.subReason || '');
  if (sub && !def.sub.includes(sub)) return 'report_invalid_sub_reason';
  if (!sub && def.sub.length && (REPORT_TAXONOMY[type].subRequired || def.subRequired)) return 'report_sub_reason_required';
  const d = String(it.description || '').trim();
  if (d.length < 5 || d.length > 200) return 'report_invalid_description';
  return null;
}
