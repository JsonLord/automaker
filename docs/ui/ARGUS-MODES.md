# Using Argus modes

The board's **Argus mode** selector offers Default, REA, Paper2Code and Eval. Mode
selection persists per project and does not start an autonomous campaign.

Open the mode-specific configuration panel to grant only the capabilities and
permissions the project needs, then save. Enter the mode's paper, research evidence
or versioned dataset input in its input panel. Examples are editable fixtures,
not reported production observations; REA authorization starts false and the Eval
example requires the real candidate source SHA.

Choose **Plan**, inspect the steps/blocked reasons and exact source commit, then
choose **Run plan** explicitly. For a reference implementation, enable its capability
and repository-change permission before planning, then check the approval for this
plan's SHA. Generated files go into a separate worktree. Unapproved execution
produces an explicit blocked reproduction report rather than inventing results.
Task proposals need their own approval to enter existing Argus/Jules, whose autonomy
must already have been enabled independently. Human merge remains mandatory.

Run history, measured scores, task IDs, evidence hashes and escaped artifact content
are in the same panel. Refresh reads durable status after restart. Kanban cards show
the mode, run ID, status and task/evidence references; mode-owned cards cannot be
started by the generic auto-mode controls. Active incompatible tasks/runs prevent
switching; safely finish/drain them first. Never use a mode switch to abandon a
running external task.

In agent chat, `/default`, `/rea`, `/paper2code` and `/eval` select and describe modes.
They do not execute work, call the model, start a campaign, or grant permissions.
Use the board's explicit Plan/Run controls to execute a mode workflow. Documents and
artifact markup render as text and cannot become scripts or instructions to tools.
