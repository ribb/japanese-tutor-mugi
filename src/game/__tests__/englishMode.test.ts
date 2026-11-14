import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { isTargetLanguage, userTurn } from '../claudeProtocol';
import { activeCharacter, addCharacter, characterTargetLanguage, DEFAULT_TUTOR, effectivePersona, migrateTutor, TUTOR_NEW_EN_SUBTITLE } from '../tutor';
import { DEFAULT_EN_TUTOR, NEUTRAL_EN_PERSONA } from '../tutorCharacters';
import {
  CEFR_LEVELS, jaDisplay, jaSpeakable, levelBadge, normalizeLevel, parseLookupText, stripJaTags,
} from '../lookup';
import { splitTip, topicSent, userChatLine } from '../claudeBrain';
import { EN_POCKET_TOPICS, nextPocketTopic, POCKET_TOPICS } from '../pocketTopics';
import { detectLang, ENGINE_CHOICES, migrateTtsSettings } from '../tts';
import { speakPlanFor } from '../characterVoice';
import {
  JUDGE_PROMPT_EN, LOOKUP_SYSTEM_EN, reminderPrompt, systemPrompt, TIP_FIX_SYSTEM_EN,
} from '../../../server/prompts.ts';
import { fixReplyJson, isChineseEnTip, needsEnTipRewrite } from '../../../server/replyFix.ts';
import {
  CHAT_REPLY_SCHEMA_EN, chatRequest, LOOKUP_SCHEMA_EN, lookupAnswerWith, parseChatBody, rewriteTipWith,
} from '../../../server/claudeChat.ts';
import { answerTts, edgeSynthesize, engineConfigured, parseTtsBody, TTS_VOICES, type EdgeTtsClient } from '../../../server/tts.ts';
import type { LlmCompleteRequest, LlmProvider, LlmResult } from '../../../server/llm/provider.ts';

function fakeProvider(text: string) {
  const reqs: LlmCompleteRequest[] = [];
  const provider: LlmProvider = {
    id: 'anthropic',
    streamChat() {
      throw new Error('streamChat is not used here');
    },
    async complete(req): Promise<LlmResult> {
      reqs.push(req);
      return { text, model: req.model, stopReason: 'end_turn' };
    },
    describeError: () => ({ status: 500, message: 'fake' }),
  };
  return { provider, reqs };
}

describe('TargetLanguage and bilingual character state', () => {
  it('validates targetLanguage values and defaults legacy characters to ja', () => {
    expect(isTargetLanguage('ja')).toBe(true);
    expect(isTargetLanguage('en')).toBe(true);
    expect(isTargetLanguage('fr')).toBe(false);
    expect(characterTargetLanguage(DEFAULT_TUTOR.characters[0])).toBe('ja');
  });

  it('adds an English character with targetLanguage en, default Emma subtitle, and sttLang en-US', () => {
    const next = addCharacter(DEFAULT_TUTOR, 'c-en', 'en');
    expect(next).not.toBeNull();
    const enChar = activeCharacter(next!);
    expect(characterTargetLanguage(enChar)).toBe('en');
    expect(enChar.name).toBe(DEFAULT_EN_TUTOR.defaultName);
    expect(enChar.subtitle).toBe(DEFAULT_EN_TUTOR.subtitle);
    expect(effectivePersona(enChar)).toBe(NEUTRAL_EN_PERSONA);
    expect(next!.sttLang).toBe('en-US');
  });

  it('preserves targetLanguage: en and en-US / en-GB sttLang across migrateTutor', () => {
    const m = migrateTutor({
      activeId: 'emma',
      sttLang: 'en-GB',
      characters: [{ id: 'emma', name: 'Emma', subtitle: '', persona: '', targetLanguage: 'en' }],
    });
    expect(m.activeId).toBe('emma');
    expect(m.sttLang).toBe('en-GB');
    expect(activeCharacter(m).subtitle).toBe(TUTOR_NEW_EN_SUBTITLE);
    expect(characterTargetLanguage(activeCharacter(m))).toBe('en');
  });

  it('formats userTurn and userChatLine with ［模式：英語老師］ in English mode', () => {
    expect(userTurn('Hello!', { timeOfDay: '晚上 8 點' }, 'teacher', 'en')).toBe(
      '［情境：晚上 8 點］［模式：英語老師］Hello!',
    );
    expect(userChatLine('How are you?', {}, 'teacher', 123, 'en').sent).toBe('［模式：英語老師］How are you?');
    expect(topicSent('How was your day?', '你今天過得如何？', 'en')).toBe(
      '{"segments":[{"lang":"en","text":"How was your day?","gloss":"你今天過得如何？"}],"tip":"","tone":"happy"}',
    );
  });
});

describe('English prompts and Structured Outputs schemas', () => {
  it('builds stable English systemPrompt and reminderPrompt without touching Japanese prompts', () => {
    const sysEn = systemPrompt('Mugi', undefined, 'Emma', 'en');
    expect(sysEn).toContain('專門教他英語的家教');
    expect(sysEn).toContain('英語老師模式');
    expect(sysEn).toContain('"en"');
    expect(sysEn).toContain('CEFR');
    const remEn = reminderPrompt('en');
    expect(remEn).toContain('<en>');
    expect(remEn).toContain('"lang":"en"');
    expect(remEn).toContain('"tipLevel":"A1"');
  });

  it('selects CHAT_REPLY_SCHEMA_EN and English prompts in chatRequest when targetLanguage is en', () => {
    const body = parseChatBody(JSON.stringify({
      messages: [{ role: 'user', content: 'Hello!' }],
      role: 'Mugi',
      mode: 'teacher',
      context: {},
      targetLanguage: 'en',
      name: 'Emma',
    }));
    expect(body.targetLanguage).toBe('en');
    const req = chatRequest(body, 'claude-sonnet-5-5');
    expect(req.output_config?.format).toEqual({ type: 'json_schema', schema: CHAT_REPLY_SCHEMA_EN });
    expect(CHAT_REPLY_SCHEMA_EN.properties.segments.items.properties.lang.enum).toEqual(['en', 'zh']);
    expect(CHAT_REPLY_SCHEMA_EN.properties.tipLevel.enum).toEqual(['', ...CEFR_LEVELS]);
    const sysText = Array.isArray(req.system) ? (req.system[0] as { text: string }).text : '';
    expect(sysText).toContain('專門教他英語的家教');
  });
});

describe('English reply post-processing (skips kuromoji)', () => {
  it('keeps English segments and CEFR tipLevel without adding kanji readings', async () => {
    const raw = JSON.stringify({
      segments: [{ lang: 'en', text: 'Oh really! Did you have fun at school?', gloss: '真的嗎！你在學校玩得開心嗎？' }],
      tip: '表達過去去了哪裡要用過去式，可以說 <en>I went to school yesterday.</en> 喔。',
      tipLevel: 'A2',
      tone: 'happy',
    });
    const fixed = await fixReplyJson(raw, { targetLanguage: 'en' });
    expect(fixed.tipRewrite).toBe(false);
    const parsed = JSON.parse(fixed.json);
    expect(parsed).toEqual({
      segments: [{ lang: 'en', text: 'Oh really! Did you have fun at school?', gloss: '真的嗎！你在學校玩得開心嗎？' }],
      tip: '表達過去去了哪裡要用過去式，可以說 <en>I went to school yesterday.</en> 喔。',
      tipLevel: 'A2',
      tone: 'happy',
    });
  });

  it('flags an all-English tip for background rewrite into Traditional Chinese', async () => {
    expect(needsEnTipRewrite('Use the past tense <en>I went to school</en> for yesterday.')).toBe(true);
    expect(isChineseEnTip('要用過去式 <en>I went to school</en> 喔。')).toBe(true);
    const raw = JSON.stringify({
      segments: [{ lang: 'en', text: 'Sounds great!', gloss: '聽起來很棒！' }],
      tip: 'You should say <en>I went to school</en>.',
      tipLevel: 'A1',
      tone: 'explain',
    });
    const fixed = await fixReplyJson(raw, { targetLanguage: 'en' });
    expect(fixed.tipRewrite).toBe(true);
  });

  it('rewrites an English tip using TIP_FIX_SYSTEM_EN without running kuromoji', async () => {
    const { provider, reqs } = fakeProvider('{"tip":"描述昨天發生的事要用過去式 <en>I went to school.</en> 喔。"}');
    const out = await rewriteTipWith(provider, 'Use past tense <en>I went to school.</en>', undefined, undefined, 'en');
    expect(reqs[0].system).toBe(TIP_FIX_SYSTEM_EN);
    expect(out).toBe('描述昨天發生的事要用過去式 <en>I went to school.</en> 喔。');
  });

  it('splitTip extracts targets from both <en> and <ja> tags', () => {
    expect(splitTip('可以說 <en>How is it going?</en> 或 <en>What’s up?</en> 喔。')).toEqual({
      text: '可以說 How is it going? 或 What’s up? 喔。',
      targets: ['How is it going?', 'What’s up?'],
    });
  });
});

describe('English lookup (CEFR levels and <en> tags)', () => {
  it('normalizes CEFR levels A1–C2 alongside JLPT N1–N5', () => {
    expect(normalizeLevel('A1')).toBe('A1');
    expect(normalizeLevel('b2')).toBe('B2');
    expect(normalizeLevel(' c1 ')).toBe('C1');
    expect(normalizeLevel('C3')).toBe('級外');
    expect(levelBadge('B1')).toBe('「B1」');
  });

  it('strips <en> and <ja> tags in lookup helpers and preserves English text without kuromoji', async () => {
    expect(stripJaTags('<en>break the ice</en>')).toBe('break the ice');
    expect(jaSpeakable('<en>break the ice</en>')).toBe('break the ice');
    expect(jaDisplay('<en>break the ice</en>')).toBe('break the ice');

    const reply = JSON.stringify({
      items: [{ ja: '<en>break the ice</en>', zh: '打破僵局', level: 'B2', note: '/breɪk ðə aɪs/ 常用於初次見面' }],
      grammar: [{ point: '<en>be used to + V-ing</en>', level: 'B1', explain: '表示習慣於某事' }],
      examples: [{ ja: '<en>He told a joke to break the ice.</en>', zh: '他講了個笑話來打破僵局。' }],
      message: '',
    });
    const { provider, reqs } = fakeProvider(reply);
    const r = await lookupAnswerWith(provider, '打破僵局', undefined, undefined, 'en');
    expect(reqs[0].system).toBe(LOOKUP_SYSTEM_EN);
    expect(reqs[0].output_config?.format).toEqual({ type: 'json_schema', schema: LOOKUP_SCHEMA_EN });
    expect(r.answer?.items[0]).toEqual({
      ja: '<ja>break the ice</ja>',
      zh: '打破僵局',
      level: 'B2',
      note: '/breɪk ðə aɪs/ 常用於初次見面',
    });
    expect(r.answer?.grammar[0].level).toBe('B1');
    expect(parseLookupText(reply)?.items[0].level).toBe('B2');
    expect(JUDGE_PROMPT_EN).toContain('英語口說練習');
  });
});

describe('msedge-tts integration and English TTS pipeline', () => {
  it('configures edge without any API key and lists zh, ja, en voices', () => {
    expect(engineConfigured({ azureKey: '', azureRegion: '', googleKey: '' }, 'edge')).toBe(true);
    expect(TTS_VOICES.edge.en[0].id).toBe('en-US-JennyNeural');
    expect(TTS_VOICES.edge.ja[0].id).toBe('ja-JP-NanamiNeural');
    expect(TTS_VOICES.edge.zh[0].id).toBe('zh-TW-HsiaoChenNeural');
    expect(parseTtsBody(JSON.stringify({ engine: 'edge', voice: 'en-US-JennyNeural', text: 'Hello world!' }))).toEqual({
      engine: 'edge',
      voice: 'en-US-JennyNeural',
      text: 'Hello world!',
      rate: 1,
      pitch: 1,
    });
  });

  it('synthesizes MP3 audio via edgeSynthesize and closes the client', async () => {
    let closed = false;
    let chosenVoice = '';
    const fakeClient: EdgeTtsClient = {
      async setMetadata(voiceName) {
        chosenVoice = voiceName;
      },
      toStream() {
        const stream = new PassThrough();
        queueMicrotask(() => {
          stream.write(Buffer.from('ID3-fake-mp3-audio'));
          stream.end();
        });
        return { audioStream: stream };
      },
      close() {
        closed = true;
      },
    };
    const buf = await edgeSynthesize('en-US-JennyNeural', 'Hello & welcome!', 1, 1, 5000, () => fakeClient);
    expect(chosenVoice).toBe('en-US-JennyNeural');
    expect(buf.toString('utf8')).toBe('ID3-fake-mp3-audio');
    expect(closed).toBe(true);
  });

  it('caches edge synthesis in answerTts and never falls back on quota', async () => {
    const store = new Map<string, Buffer>();
    const synth = vi.fn(async () => Buffer.from('mp3-bytes'));
    const deps = {
      cache: {
        peek: (k: string) => store.get(k),
        lookup: async (k: string) => store.get(k),
        fetchOnce: async (k: string, fn: () => Promise<Buffer>) => {
          const hit = store.has(k);
          if (!hit) store.set(k, await fn());
          return { buf: store.get(k)!, hit };
        },
      },
      usage: {
        ttsUsed: () => 999_999_999,
        recordTts: vi.fn(),
        recordTtsCacheHit: vi.fn(),
        recordTtsFallback: vi.fn(),
      },
      synth,
      azureConfigured: false,
    };
    const body = { engine: 'edge' as const, voice: 'en-US-JennyNeural', text: 'Nice to meet you!', rate: 1, pitch: 1 };
    const first = await answerTts(body, deps);
    expect(first.kind).toBe('audio');
    expect(synth).toHaveBeenCalledTimes(1);
    const second = await answerTts(body, deps);
    expect(second.kind).toBe('audio');
    if (second.kind === 'audio') expect(second.hit).toBe(true);
    expect(synth).toHaveBeenCalledTimes(1);
  });

  it('detects English sentences, defaults en TTS to edge, and plans English character voices', () => {
    expect(detectLang('Hello, how are you today?')).toBe('en');
    expect(detectLang('こんにちは')).toBe('ja');
    expect(detectLang('你好嗎')).toBe('zh');
    expect(migrateTtsSettings({}).en.engine).toBe('edge');
    expect(ENGINE_CHOICES.en.map((c) => c.engine)).toEqual(['browser', 'edge', 'azure', 'google']);
    expect(speakPlanFor({ gender: 'female' }, 'edge', () => [], 'en')).toEqual({
      kind: 'cloud',
      engine: 'edge',
      voice: 'en-US-JennyNeural',
    });
    expect(speakPlanFor({ gender: 'male' }, 'edge', () => [], 'en')).toEqual({
      kind: 'cloud',
      engine: 'edge',
      voice: 'en-US-GuyNeural',
    });
  });
});

describe('100 English pocket topics', () => {
  it('provides 100 distinct English pocket topics without affecting the 100 Japanese topics', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => store.clear(),
    });
    try {
      expect(POCKET_TOPICS).toHaveLength(100);
      expect(EN_POCKET_TOPICS).toHaveLength(100);
      const seen = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const t = nextPocketTopic(Math.random, 'en');
        expect(t.ja).toMatch(/[A-Za-z]/);
        expect(t.jaZh.length).toBeGreaterThan(0);
        seen.add(t.ja);
      }
      expect(seen.size).toBe(100);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
