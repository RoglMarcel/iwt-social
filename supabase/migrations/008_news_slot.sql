-- 008: news slot at 08:00 New York, appended so the existing slot numbers stay the same.
-- Applied only after the function that understands lanes is deployed (an older function would
-- fill this slot with a regular carousel).
update iwt.settings
set slots = slots || '[{"kind":"carousel","time":"08:00","lane":"news"}]'::jsonb
where id = 1;
