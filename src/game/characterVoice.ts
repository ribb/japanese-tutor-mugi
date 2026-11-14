// 日語家教's voice per character (人物 › 聲音): pure, so it is tested with plain objects. A character's voice is either null
// (follow the 設定 page's voice of the language) or a choice: a cloud engine and a Japanese voice of it, or only a gender, which
// picks that engine's voice of the gender (the 設定 page's engine, or the engine of the choice). The speak plan is what the speech
// queue (game/tts) uses for her Japanese lines; null = the 設定 page's own voice.
export type CloudEngineId = 'edge' | 'azure' | 'google' | 'voicevox';
export type VoiceGender = 'female' | 'male';
export const VOICE_GENDERS: readonly VoiceGender[] = ['female', 'male'];

/** a voice listed for an engine (the same shape as the server's status list: id, label, and VOICEVOX's speaker name) */
export type VoiceOption = { id: string; label: string; character?: string };

export type CharacterVoice = { engine?: CloudEngineId; ja?: string; gender?: VoiceGender } | null;

/** what a line of hers is spoken with: a cloud voice, or the device voice with its pitch factor (a male voice has a lower pitch) */
export type SpeakPlan = { kind: 'cloud'; engine: CloudEngineId; voice: string } | { kind: 'browser'; pitch: number };

/** the device voice has no voice list, so a male character is lower by this factor (the 設定 page's pitch times it) */
export const BROWSER_MALE_PITCH = 0.8;

/** VOICEVOX speakers by name: the first one of the list that the engine offers is the default of its gender */
export const VOICEVOX_MALE_SPEAKERS = ['玄野武宏', '白上虎太郎', '青山龍星'] as const;
export const VOICEVOX_FEMALE_SPEAKERS = ['四国めたん', '春日部つむぎ', '雨晴はう', '波音リツ', 'ずんだもん'] as const;

/** the Edge, Azure and Google Japanese voices of each gender (the first is the default; the server's allowlist, server/tts.ts, has them) */
export const CLOUD_JA_VOICES: Record<'edge' | 'azure' | 'google', Record<VoiceGender, string>> = {
  edge: { female: 'ja-JP-NanamiNeural', male: 'ja-JP-KeitaNeural' },
  azure: { female: 'ja-JP-NanamiNeural', male: 'ja-JP-KeitaNeural' },
  google: { female: 'ja-JP-Neural2-B', male: 'ja-JP-Neural2-C' },
};

/** the Edge, Azure and Google English voices of each gender */
export const CLOUD_EN_VOICES: Record<'edge' | 'azure' | 'google', Record<VoiceGender, string>> = {
  edge: { female: 'en-US-JennyNeural', male: 'en-US-GuyNeural' },
  azure: { female: 'en-US-JennyNeural', male: 'en-US-GuyNeural' },
  google: { female: 'en-US-Neural2-F', male: 'en-US-Neural2-D' },
};

/** the voice of an engine for a gender: a fixed one for Edge, Azure and Google; for VOICEVOX the first speaker of the gender's list the
 *  engine offers (null when it offers none, or while it is not running, or in English mode) */
export function genderVoiceId(
  engine: CloudEngineId,
  gender: VoiceGender,
  offered: readonly VoiceOption[],
  targetLanguage: 'ja' | 'en' = 'ja',
): string | null {
  if (targetLanguage === 'en') {
    if (engine === 'voicevox') return null;
    return CLOUD_EN_VOICES[engine][gender];
  }
  if (engine !== 'voicevox') return CLOUD_JA_VOICES[engine][gender];
  const names: readonly string[] = gender === 'male' ? VOICEVOX_MALE_SPEAKERS : VOICEVOX_FEMALE_SPEAKERS;
  for (const name of names) {
    const hit = offered.find((v) => v.character === name);
    if (hit) return hit.id;
  }
  return null;
}

/**
 * A voice id is kept for an engine when the engine's list has it. While the list is not loaded yet (empty), the id is kept
 * as it is: the server refuses an id it does not offer, and cloudTts then speaks that line with the 設定 page's voice. Once the list
 * is loaded, an id it does not offer is not kept at all (speakPlanFor treats it as no choice).
 */
function listedOrUnknown(id: string, offered: readonly VoiceOption[]): boolean {
  return offered.length === 0 || offered.some((v) => v.id === id);
}

/**
 * The speak plan of a character's voice for her target-language lines. `global` is the 設定 page's engine for the target language
 * ('browser' or a cloud engine); `offered` lists the voices of an engine (empty while unknown). null = the 設定 page's voice.
 */
export function speakPlanFor(
  voice: CharacterVoice,
  global: 'browser' | CloudEngineId,
  offered: (engine: CloudEngineId) => readonly VoiceOption[],
  targetLanguage: 'ja' | 'en' = 'ja',
): SpeakPlan | null {
  if (!voice) return null;
  const gender: VoiceGender = voice.gender === 'male' ? 'male' : 'female';
  const engine: CloudEngineId | undefined = voice.engine ?? (global === 'browser' ? undefined : global);
  if (!engine) return { kind: 'browser', pitch: gender === 'male' ? BROWSER_MALE_PITCH : 1 };
  if (voice.ja && listedOrUnknown(voice.ja, offered(engine))) return { kind: 'cloud', engine, voice: voice.ja };
  // an id the loaded list does not offer is unknown: with no gender chosen there is no choice left (null, the 設定 voice speaks)
  if (voice.ja && !voice.gender) return null;
  const id = genderVoiceId(engine, gender, offered(engine), targetLanguage);
  return id ? { kind: 'cloud', engine, voice: id } : null;
}

const ENGINE_IDS: readonly CloudEngineId[] = ['edge', 'azure', 'google', 'voicevox'];

/** a voice choice a save holds: an engine, a Japanese voice id (text, 1 to 40 characters) and/or a gender; anything else is null */
export function cleanCharacterVoice(raw: unknown): CharacterVoice {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const engine = ENGINE_IDS.includes(o.engine as CloudEngineId) ? (o.engine as CloudEngineId) : undefined;
  const ja = typeof o.ja === 'string' && /^[A-Za-z0-9-]{1,40}$/.test(o.ja.trim()) ? o.ja.trim() : undefined;
  const gender = VOICE_GENDERS.includes(o.gender as VoiceGender) ? (o.gender as VoiceGender) : undefined;
  if (!engine && !ja && !gender) return null;
  return { ...(engine ? { engine } : {}), ...(ja ? { ja } : {}), ...(gender ? { gender } : {}) };
}
