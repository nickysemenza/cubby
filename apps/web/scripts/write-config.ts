import { config } from "~/testdata/real-config-data";
import fs from "fs";
import YAML from "yaml";
const writeConfig = (fileName: string) => {
  fs.writeFileSync(
    fileName,
    YAML.stringify(config, { aliasDuplicateObjects: false }),
  );
};

writeConfig("config.yaml");
