import { useEffect } from 'react';
import { Layout } from './components/Layout';
import { Link } from './components/Link';
import { Message } from './components/States';
import { browseHref, parseRoute, useLocationHref } from './lib/router';
import { BrowsePage } from './views/BrowsePage';
import { SubmitPage } from './views/SubmitPage';

export function App() {
  const href = useLocationHref();
  const url = new URL(href, window.location.origin);
  const route = parseRoute(url.pathname, url.search);
  // Browsing and a restaurant's details share one page (the list area shows
  // the details beside the same map), so the map stays put between them.
  const discovery = route.kind === 'browse' || route.kind === 'restaurant';
  const pageKey = discovery ? 'discovery' : route.kind;

  // Start new pages at the top; the discovery page scrolls inside its panels.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pageKey]);

  return (
    <Layout fill={discovery}>
      {discovery && (
        <BrowsePage
          params={route.params}
          detailId={route.kind === 'restaurant' ? route.id : undefined}
        />
      )}
      {route.kind === 'submit' && <SubmitPage restaurantId={route.restaurantId} />}
      {route.kind === 'notFound' && (
        <Message
          icon="🧭"
          title="页面不存在"
          action={
            <Link href={browseHref()} className="btn btn-primary">
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
