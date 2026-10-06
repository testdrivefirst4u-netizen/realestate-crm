'use client';

import { TasksView } from '@/src/modules/tasks/TasksView';
import { useCrm } from '../_components/CrmShell';

export function TasksClient() {
  const { engine, openLead } = useCrm();
  const { data } = engine;
  return (
    <TasksView
      tasks={data.tasks}
      notes={data.notes}
      checklist={data.checklist}
      leads={data.leads}
      users={data.users || []}
      onAddTask={engine.addTask}
      onUpdateTask={engine.updateTask}
      onToggleTask={engine.toggleTask}
      onDeleteTask={engine.deleteTask}
      onToggleTaskChecklist={engine.toggleTaskChecklist}
      onAddNote={engine.addNote}
      onDeleteNote={engine.deleteNote}
      onAddChecklist={engine.addChecklist}
      onToggleChecklist={engine.toggleChecklist}
      onDeleteChecklist={engine.deleteChecklist}
      onOpenLead={openLead}
    />
  );
}
