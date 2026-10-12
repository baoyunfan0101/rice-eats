import { useEffect } from 'react';
import { Layout } from './components/Layout';
import { Link } from './components/Link';
import { Message } from './components/States';
import { browseHref, parseRoute, useLocationHref } from './lib/router';
import { BrowsePage } from './views/BrowsePage';
import { RestaurantPage } from './views/RestaurantPage';
import { SubmitPage } from './views/SubmitPage';

export function App() {
  const href = useLocationHref();
  const url = new URL(href, window.location.origin);
  const route = parseRoute(url.pathname, url.search);
  const pageKey = route.kind === 'restaurant' ? `r:${route.id}` : route.kind;

  // Start new pages at the top; the browse page keeps its scroll position while filtering.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pageKey]);

  return (
    <Layout>
      {route.kind === 'browse' && <BrowsePage params={route.params} />}
      {route.kind === 'restaurant' && <RestaurantPage id={route.id} />}
      {route.kind === 'submit' && <SubmitPage restaurantId={route.restaurantId} />}
      {route.kind === 'notFound' && (
        <Message
          icon="🧭"
          title="页面不存在"
          action={
            <Link href={browseHref()} className="font-semibold text-chili-700 underline">
              返回首页
            </Link>
          }
        >
          这个链接可能已经失效。
        </Message>
      )}
    </Layout>
  );
}
