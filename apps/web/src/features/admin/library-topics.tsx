import { Badge } from '../../components/badge.js';

export function TopicList({ topics }: { topics: readonly string[] }) {
  return (
    <ul className="flex flex-wrap gap-1">
      {topics.map((topic) => (
        <li key={topic}>
          <Badge>{topic}</Badge>
        </li>
      ))}
    </ul>
  );
}
