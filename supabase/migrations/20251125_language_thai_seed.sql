-- ============================================================================
-- 1) Seed core Thai vocabulary for S1_GREETINGS → S1_L1
-- ============================================================================

insert into public.vocabulary_master
  (language_code, lemma, script, ipa, english_gloss, frequency_rank, part_of_speech, tags)
values
  ('th-TH', 'hello', 'สวัสดี', 'sà-wat-dii', 'hello; hi', 100, 'interjection', array['S1_GREETINGS','core']),
  ('th-TH', 'good_morning', 'สวัสดีตอนเช้า', 'sà-wat-dii dtaawn-cháo', 'good morning', 101, 'phrase', array['S1_GREETINGS','time_of_day']),
  ('th-TH', 'thank_you', 'ขอบคุณ', 'khòop-khun', 'thank you', 102, 'verb', array['S1_GREETINGS','politeness']),
  ('th-TH', 'sorry', 'ขอโทษ', 'khǒo-thôot', 'sorry; excuse me', 103, 'verb', array['S1_GREETINGS','politeness']),
  ('th-TH', 'yes', 'ใช่', 'châi', 'yes', 104, 'particle', array['S1_GREETINGS','core']),
  ('th-TH', 'no', 'ไม่ใช่', 'mâi-châi', 'no; not correct', 105, 'particle', array['S1_GREETINGS','core']),
  ('th-TH', 'please', 'กรุณา', 'kà-rú-naa', 'please (formal)', 106, 'verb', array['S1_GREETINGS','politeness']),
  ('th-TH', 'how_are_you', 'สบายดีไหม', 'sà-baai-dii mǎi', 'how are you?', 107, 'phrase', array['S1_GREETINGS','small_talk']),
  ('th-TH', 'i_am_fine', 'สบายดี', 'sà-baai-dii', 'I am fine', 108, 'phrase', array['S1_GREETINGS','small_talk']),
  ('th-TH', 'nice_to_meet_you', 'ยินดีที่ได้รู้จัก', 'yin-dii thîi-dâai-rúu-jàk', 'nice to meet you', 109, 'phrase', array['S1_GREETINGS','small_talk']);
