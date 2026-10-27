import { BottomNotices } from './BottomNotices';
import { DayView } from './day/DayView';
import { FormHost } from './form/FormHost';
import { MonthView } from './month/MonthView';
import { useRoute } from './navigation';
import { SidebarHost } from './sidebar/SidebarHost';

export function App() {
  const route = useRoute();
  return (
    <>
      {route.name === 'day' ? <DayView date={route.date} /> : <MonthView />}
      <BottomNotices />
      <FormHost />
      <SidebarHost />
    </>
  );
}
