ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_kind_check;
ALTER TABLE projects ADD CONSTRAINT projects_kind_check
  CHECK (kind IN ('mod', 'modpack', 'resourcepack', 'shader', 'native-mod'));
