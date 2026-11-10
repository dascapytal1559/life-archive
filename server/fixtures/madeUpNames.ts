// The invented names tests, fixtures and the testing data are made of: any of
// FIRST_NAMES with any of LAST_NAMES, or one of WHOLE_NAMES. Every one is made
// up; the privacy guard's review is given these lists (the life-archive policy's name file), with PUBLIC_FIGURES and
// STAND_INS below for what they are, so it reads only other names as maybe real. A test that needs a new name, a
// single first name too, adds it here first; madeUpNames.test.ts holds every pair of names the tests and fixtures
// write to these lists.

/** The made-up crowd's first names (crowd.ts), in the order its seeded picks depend on. */
export const CROWD_FIRST: readonly string[] = [
  "Ada", "Bruno", "Cleo", "Dev", "Esme", "Felix", "Gia", "Hugo", "Iris", "Jonah", "Kira", "Leo", "Mira", "Nico", "Orla",
  "Pax", "Quinn", "Rosa", "Sami", "Tess", "Uma", "Vik", "Wren", "Xavi", "Yara", "Zed", "Alba", "Bodhi", "Cass", "Dara",
  "Elio", "Fern", "Gus", "Hana", "Ivo", "Juno", "Kai", "Luz", "Milo", "Noor", "Otto", "Pia", "Rafe", "Sol", "Theo",
  "Vera", "Wim", "Yuki", "Zora", "Arlo",
];

/** The made-up crowd's last names (crowd.ts), in the order its seeded picks depend on. */
export const CROWD_LAST: readonly string[] = [
  "Sample", "Placeholder", "Example", "Testington", "Fictional", "Demo", "Madeup", "Notreal", "Standin", "Dummy",
  "Mockley", "Pretendo", "Fakeworth", "Imaginary", "Invent", "Synthetic", "Proxy", "Lorem", "Ipsum", "Quux",
];

/** The made-up crowd's own name, yours in it (crowd.ts). */
export const CROWD_SELF = "Riley Self";

/** Every made-up first name, and the nicknames made from them. */
export const FIRST_NAMES: readonly string[] = [
  ...CROWD_FIRST,
  "Addy", "Al", "Bea", "Ben", "Bo", "Cy", "Dana", "Dee", "Di", "Dora", "Eve", "Fay", "Hal", "Ida", "Ivy", "Jo", "Kiara", "Kim", "Lew",
  "Lu", "Mae", "Nia", "Ned", "Nora", "Nova", "Opal", "Pat", "Patrice", "Riley", "Rowan", "Rudi", "Ruth", "Sam", "Selma", "Sid",
  "Siv", "Tia", "Walt",
  "Ads", "Alex", "Alexia", "Cal", "Dot", "Ed", "Flo", "Émile", "José", "Mia", "Ryan", "Sasha", "Wally", "Zoë",
  "Cléo", "Dan", "Dannoxa", "Devon", "Elijah", "Elistro", "Fin", "Finn", "Gil", "Hanako", "Kip", "Mo", "Mowbray", "Qin",
  "Quo", "Rex", "Sal", "Sally", "Samuel", "Sunny", "Tam", "Tenvik", "Una", "Wen", "Wenjie", "Zoe",
];

/** Every made-up last name, many of them saying what the person is for in a test. */
export const LAST_NAMES: readonly string[] = [
  ...CROWD_LAST,
  "Answered", "Belt", "Bigchat", "Captain", "Edited", "Elsewhere", "Fakeley", "Far", "Fixture", "Grey", "Hand", "Hue", "Ink",
  "Kettle", "Key", "Longname", "Moxie", "Near", "New", "Newface", "Old", "Other", "Quiet", "Quill", "Renamed", "Roe", "Self",
  "Seller", "Smallchat", "Stranger", "Test", "Testperson", "Third", "Typing", "Unanswered", "Unlisted", "Vendorly", "Liu",
  "Glyn", "Jones", "Jr",
];

/**
 * Made-up names in other shapes: ones that read like anyone's, for tests of
 * short, common or non-Latin names, and the stand-ins the history rewrite
 * put where a real name was. Invented all the same.
 */
export const WHOLE_NAMES: readonly string[] = [
  "Ada Smith", "Al Bo", "Alex Tan", "Bartholomew Longname", "Bruno Pellegrini", "Bruno Ryan", "Dana Lee", "Dana Mae", "Di One",
  "Di Two", "Haruki Oda", "Jo Doe", "Joanna Draftly", "Kit Ng", "Li Li", "Maya Okafor", "Mia Wong", "Pat Doe", "Patrice Bligh",
  "Patrice Brook", "Quill Rowan", "Quinn Xavier", "Quinn Xavier Testperson", "Robert Bo", "Rowan Ryan", "Ryan Zhou",
  "Sam Quorvel Smith", "Sam Smith", "Sam Stone", "Sample Captain", "Seller Example", "Somebody Longname", "Stranger Example",
  "Testperson Quinn", "Tom Tom", "Xavier Testperson", "Zhou Fang", "Odd Name",
  "Alexia L", "José Ñúñez", "José Wu", "Ryan Li", "ＲＹＡＮ Ｌｉ", "Sam Belt Busy", "Sam Belt Quiet",
  "Ryan 周", "周伟", "周 伟", "伟哥", "陈五", "林小雨", "芳芳", "测试员", "赵小红", "张三", "李 小明",
  "山田 太郎", "さくら", "サクラ", "김 민준", "김민준", "민준",
];

/**
 * Not made up, and so in none of the lists above: public figures some tests name as their people (a name everyone
 * knows, belonging to no one in the archive). The review is told of them as public figures, which the policy allows.
 */
export const PUBLIC_FIGURES: readonly string[] = ["Ada Lovelace", "Bea Arthur", "Beatrice Arthur", "Bryan Johnson", "Cy Twombly"];

/**
 * Invented, but never one of the made-up names: the stand-ins the guard's and the demo check's own tests put in a test
 * archive's dictionary to play a real person, which those checks must stop. The review is told they are stand-ins.
 */
export const STAND_INS: readonly string[] = ["Zelda Privateer"];

/** Made-up nicknames, one word each, for the testing data's aliases (Ada Sample's "Addy"). */
export const NICKNAMES: readonly string[] = ["Addy"];

/** The n-th made-up name, for a test that needs many: every first name with the first last name, then with the next. */
export function madeUpName(n: number): string {
  const first = FIRST_NAMES[n % FIRST_NAMES.length];
  const last = LAST_NAMES[Math.floor(n / FIRST_NAMES.length) % LAST_NAMES.length];
  return `${first} ${last}`;
}

/** Whether a name is one of these: a first and a last from the lists, or a whole name. */
export function isMadeUpName(name: string): boolean {
  if (WHOLE_NAMES.includes(name)) return true;
  const words = name.split(" ");
  return words.length === 2 && FIRST_NAMES.includes(words[0]!) && LAST_NAMES.includes(words[1]!);
}
