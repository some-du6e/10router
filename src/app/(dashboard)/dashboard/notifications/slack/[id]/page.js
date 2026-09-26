import SlackLayoutEditor from "./SlackLayoutEditor";

export default async function SlackNotificationPage({ params }) {
  const { id } = await params;
  return <SlackLayoutEditor channelId={id} />;
}
