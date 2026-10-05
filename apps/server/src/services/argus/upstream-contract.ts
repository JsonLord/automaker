/** Contract verified against Microsoft ArgusAgent at this immutable source revision. */
export const ARGUS_UPSTREAM_CONTRACT = {
  revision: '746f76b7a74a1217507c9ee348eecd3b782f7c92',
  packageVersion: '0.1.1',
  projectCreation: {
    module: 'argus_skill.plugin.service',
    class: 'ArgusPluginService',
    // create_project(objective, workdir, ...): returns a project containing sid.
    method: 'create_project',
  },
  manager: {
    module: 'argus_skill.webapi.manager_bridge',
    // manager_message(sid, text, ...): performs admission without starting a daemon.
    function: 'manager_message',
  },
  planner: {
    module: 'argus_skill.webapi.manager_bridge',
    // manager_plan(sid, ...): invokes the configured Planner and returns steps/notes/error.
    function: 'manager_plan',
  },
} as const;
