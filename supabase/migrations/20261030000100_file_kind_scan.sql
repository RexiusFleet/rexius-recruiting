-- Manual applications, part 1 of 3: a new file kind for the scanned paper application.
--
-- A value added to an enum cannot be used in the same transaction, and every migration file
-- runs as one transaction (docs/database-conventions.md), so this value gets a file of its own
-- ahead of 20261030000200, which is the first place anything could refer to it.

alter type recruiting.file_kind add value if not exists 'scan';

comment on type recruiting.file_kind is
  'resume, portfolio: copied from Jotform uploads. scan: the scanned paper application behind '
  'a manual entry (PDF or image). other: anything else.';
