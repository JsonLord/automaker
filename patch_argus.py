import re

with open("apps/server/src/services/argus/argus-service.ts", "r") as f:
    content = f.read()

import_fs = "import fs from 'fs';\n"
if "import fs from 'fs';" not in content:
    content = content.replace("import fs from 'fs/promises';", "import fs from 'fs';\nimport fsp from 'fs/promises';")
    content = content.replace("fs.realpath", "fsp.realpath")

replacement = """    private bridgePath = process.env.ARGUS_BRIDGE_PATH ||
      (fs.existsSync(path.resolve(process.cwd(), 'scripts', 'argus_runtime_bridge.py'))
        ? path.resolve(process.cwd(), 'scripts', 'argus_runtime_bridge.py')
        : path.resolve(process.cwd(), '../../scripts', 'argus_runtime_bridge.py'))"""

content = content.replace("    private bridgePath = process.env.ARGUS_BRIDGE_PATH ||\n      path.resolve(process.cwd(), 'scripts', 'argus_runtime_bridge.py')", replacement)

with open("apps/server/src/services/argus/argus-service.ts", "w") as f:
    f.write(content)
