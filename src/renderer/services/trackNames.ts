/**
 * trackNames — 赛道(内容 niche)名的统一多语言映射。
 *
 * 背景:任务列表 / 详情 / 运行记录卡片都要显示用户选的赛道名(如「美食 · 探店做饭」)。
 * 原来这份映射在 4 个组件里各硬编码一份 Record<string,{icon,name_zh}>(MyTasksPage /
 * RunHistoryPage / RunRecordDetailPage / TaskDetailPage),且【只有中文】—— 英文/日语等
 * UI 下赛道行仍是中文。这里统一成一份 9 语映射(覆盖全部 UI 语言),各处 import 复用,
 * 渲染按 i18nService.currentLanguage 取对应语言(缺失回落 en → zh → key)。
 *
 * ⚠️ task.title(用户/预设的内容名)不在此列 —— 那是用户数据,不翻译(见交接:保留原样)。
 */

export interface TrackMeta {
  icon: string;
  zh: string;
  en: string;
  'zh-TW': string;
  ko: string;
  ja: string;
  ru: string;
  fr: string;
  de: string;
  vi: string;
}

export const TRACK_META: Record<string, TrackMeta> = {
  // Twitter / Binance (web3) tracks
  web3_alpha:   { icon: '🎯', zh: 'Web3 · Alpha 猎人', en: 'Web3 · Alpha Hunter', 'zh-TW': 'Web3 · Alpha 獵人', ko: 'Web3 · Alpha 헌터', ja: 'Web3 · Alpha ハンター', ru: 'Web3 · Alpha-охотник', fr: "Web3 · Chasseur d'Alpha", de: 'Web3 · Alpha-Jäger', vi: 'Web3 · Thợ săn Alpha' },
  web3_defi:    { icon: '🏛️', zh: 'Web3 · DeFi 用户', en: 'Web3 · DeFi User', 'zh-TW': 'Web3 · DeFi 用戶', ko: 'Web3 · DeFi 유저', ja: 'Web3 · DeFi ユーザー', ru: 'Web3 · DeFi-пользователь', fr: 'Web3 · Utilisateur DeFi', de: 'Web3 · DeFi-Nutzer', vi: 'Web3 · Người dùng DeFi' },
  web3_meme:    { icon: '🎪', zh: 'Web3 · Meme 文化', en: 'Web3 · Meme Culture', 'zh-TW': 'Web3 · Meme 文化', ko: 'Web3 · Meme 문화', ja: 'Web3 · Meme 文化', ru: 'Web3 · Meme-культура', fr: 'Web3 · Culture Meme', de: 'Web3 · Meme-Kultur', vi: 'Web3 · Văn hóa Meme' },
  web3_builder: { icon: '🛠️', zh: 'Web3 · 建设者', en: 'Web3 · Builder', 'zh-TW': 'Web3 · 建設者', ko: 'Web3 · 빌더', ja: 'Web3 · ビルダー', ru: 'Web3 · Билдер', fr: 'Web3 · Bâtisseur', de: 'Web3 · Builder', vi: 'Web3 · Nhà xây dựng' },
  web3_zh_kol:  { icon: '📢', zh: 'Web3 · 通用 KOL', en: 'Web3 · KOL', 'zh-TW': 'Web3 · 通用 KOL', ko: 'Web3 · 종합 KOL', ja: 'Web3 · 総合 KOL', ru: 'Web3 · KOL', fr: 'Web3 · KOL généraliste', de: 'Web3 · Allround-KOL', vi: 'Web3 · KOL tổng hợp' },
  // XHS / general niche tracks
  career_side_hustle: { icon: '💼', zh: '副业 · 打工人赚钱', en: 'Side Hustle · Extra Income', 'zh-TW': '副業 · 上班族賺錢', ko: '부업 · 직장인 부수입', ja: '副業 · 会社員の副収入', ru: 'Подработка · Доп. доход', fr: "Job d'appoint · Revenu extra", de: 'Nebenjob · Zusatzverdienst', vi: 'Nghề tay trái · Kiếm thêm' },
  indie_dev:    { icon: '👩‍💻', zh: '独立开发 · 程序员记录', en: 'Indie Dev · Coding Log', 'zh-TW': '獨立開發 · 工程師日誌', ko: '인디 개발 · 개발 일지', ja: '個人開発 · エンジニア日記', ru: 'Инди-разработка · Дневник кодинга', fr: 'Dev indé · Journal de code', de: 'Indie-Dev · Coding-Log', vi: 'Lập trình độc lập · Nhật ký code' },
  personal_finance: { icon: '💰', zh: '理财 · 记账攻略', en: 'Finance · Budgeting Tips', 'zh-TW': '理財 · 記帳攻略', ko: '재테크 · 가계부 팁', ja: 'マネー · 家計簿術', ru: 'Финансы · Учёт бюджета', fr: 'Finances · Astuces budget', de: 'Finanzen · Budget-Tipps', vi: 'Tài chính · Mẹo ghi chép chi tiêu' },
  travel:       { icon: '✈️', zh: '旅行 · 攻略分享', en: 'Travel · Guides', 'zh-TW': '旅行 · 攻略分享', ko: '여행 · 여행 가이드', ja: '旅行 · 旅のガイド', ru: 'Путешествия · Гайды', fr: 'Voyage · Bons plans', de: 'Reisen · Guides', vi: 'Du lịch · Cẩm nang' },
  food:         { icon: '🍲', zh: '美食 · 探店做饭', en: 'Food · Eats & Cooking', 'zh-TW': '美食 · 探店做菜', ko: '맛집 · 탐방과 요리', ja: 'グルメ · 食べ歩き＆料理', ru: 'Еда · Обзоры и готовка', fr: 'Cuisine · Restos & recettes', de: 'Essen · Restaurants & Kochen', vi: 'Ẩm thực · Review & nấu ăn' },
  outfit:       { icon: '👗', zh: '穿搭 · 风格分享', en: 'Outfits · Style Sharing', 'zh-TW': '穿搭 · 風格分享', ko: '패션 · 스타일 공유', ja: 'コーデ · スタイル紹介', ru: 'Образы · Стиль', fr: 'Mode · Partage de style', de: 'Outfits · Style-Tipps', vi: 'Phối đồ · Chia sẻ phong cách' },
  beauty:       { icon: '💄', zh: '美妆 · 产品测评', en: 'Beauty · Product Reviews', 'zh-TW': '美妝 · 產品評測', ko: '뷰티 · 제품 리뷰', ja: 'コスメ · 商品レビュー', ru: 'Красота · Обзоры товаров', fr: 'Beauté · Tests produits', de: 'Beauty · Produkttests', vi: 'Làm đẹp · Đánh giá sản phẩm' },
  fitness:      { icon: '💪', zh: '健身 · 减脂日记', en: 'Fitness · Fat-Loss Diary', 'zh-TW': '健身 · 減脂日記', ko: '피트니스 · 다이어트 일기', ja: 'フィットネス · 減量日記', ru: 'Фитнес · Дневник похудения', fr: 'Fitness · Journal minceur', de: 'Fitness · Abnehm-Tagebuch', vi: 'Gym · Nhật ký giảm mỡ' },
  reading:      { icon: '📚', zh: '读书 · 书单笔记', en: 'Reading · Book Notes', 'zh-TW': '讀書 · 書單筆記', ko: '독서 · 책 노트', ja: '読書 · 読書ノート', ru: 'Чтение · Заметки о книгах', fr: 'Lecture · Notes de livres', de: 'Lesen · Buchnotizen', vi: 'Đọc sách · Ghi chú sách' },
  parenting:    { icon: '🧸', zh: '育儿 · 亲子日常', en: 'Parenting · Family Life', 'zh-TW': '育兒 · 親子日常', ko: '육아 · 아이와 일상', ja: '育児 · 親子の日常', ru: 'Дети · Семейные будни', fr: 'Parentalité · Vie de famille', de: 'Elternsein · Familienalltag', vi: 'Nuôi con · Nhật ký gia đình' },
  exam_prep:    { icon: '🎓', zh: '考研 · 备考党', en: 'Grad Exam · Study Prep', 'zh-TW': '考研 · 備考日常', ko: '대학원 시험 · 시험 준비', ja: '大学院受験 · 受験対策', ru: 'Экзамены · Подготовка', fr: 'Concours · Révisions', de: 'Prüfung · Lernvorbereitung', vi: 'Ôn thi · Chuẩn bị thi' },
  pets:         { icon: '🐱', zh: '宠物 · 猫狗日常', en: 'Pets · Cats & Dogs Daily', 'zh-TW': '寵物 · 貓狗日常', ko: '반려동물 · 냥이멍이 일상', ja: 'ペット · 猫犬の日常', ru: 'Питомцы · Будни котов и собак', fr: 'Animaux · Chats & chiens', de: 'Haustiere · Katzen & Hunde', vi: 'Thú cưng · Chó mèo mỗi ngày' },
  home_decor:   { icon: '🏠', zh: '家居 · 小屋布置', en: 'Home · Decor Ideas', 'zh-TW': '家居 · 小屋佈置', ko: '홈 · 인테리어 꾸미기', ja: 'インテリア · お部屋づくり', ru: 'Дом · Уют и декор', fr: 'Déco · Aménagement', de: 'Wohnen · Deko-Ideen', vi: 'Nhà cửa · Trang trí không gian' },
  study_method: { icon: '🏆', zh: '学习 · 效率工具', en: 'Study · Productivity Tools', 'zh-TW': '學習 · 效率工具', ko: '공부 · 효율 도구', ja: '勉強 · 効率化ツール', ru: 'Учёба · Инструменты продуктивности', fr: 'Études · Outils de productivité', de: 'Lernen · Produktivitäts-Tools', vi: 'Học tập · Công cụ hiệu suất' },
  career_growth: { icon: '🎯', zh: '职场 · 升级打怪', en: 'Career · Leveling Up', 'zh-TW': '職場 · 升級打怪', ko: '직장 · 커리어 성장', ja: 'キャリア · スキルアップ', ru: 'Карьера · Прокачка', fr: 'Carrière · Montée en niveau', de: 'Karriere · Level-Up', vi: 'Sự nghiệp · Lên trình' },
  emotional_wellness: { icon: '🧘', zh: '情感 · 心理疗愈', en: 'Wellness · Emotional Healing', 'zh-TW': '情感 · 心理療癒', ko: '감정 · 마음 치유', ja: 'メンタル · 心のケア', ru: 'Чувства · Душевное исцеление', fr: 'Émotions · Bien-être mental', de: 'Gefühle · Seelische Heilung', vi: 'Cảm xúc · Chữa lành tâm lý' },
  photography:  { icon: '📷', zh: '摄影 · 日常记录', en: 'Photography · Everyday Moments', 'zh-TW': '攝影 · 日常記錄', ko: '사진 · 일상 기록', ja: '写真 · 日常の記録', ru: 'Фото · Повседневные моменты', fr: 'Photo · Instants du quotidien', de: 'Fotografie · Alltagsmomente', vi: 'Nhiếp ảnh · Ghi lại thường ngày' },
  crafts:       { icon: '🎨', zh: '手工 · DIY', en: 'Crafts · DIY', 'zh-TW': '手作 · DIY', ko: '핸드메이드 · DIY', ja: 'ハンドメイド · DIY', ru: 'Рукоделие · DIY', fr: 'Loisirs créatifs · DIY', de: 'Basteln · DIY', vi: 'Thủ công · DIY' },
};

/** 按 UI 语言取赛道名。缺失语言回落 en → zh → key。未知 key 返回 ''(调用方自行兜底)。 */
export function trackDisplayName(key: string, lang: string): string {
  const m = TRACK_META[key];
  if (!m) return '';
  return (m as unknown as Record<string, string>)[lang] || m.en || m.zh || key;
}

/** 赛道图标(未知 key 返回 '')。 */
export function trackIcon(key: string): string {
  return TRACK_META[key]?.icon || '';
}
