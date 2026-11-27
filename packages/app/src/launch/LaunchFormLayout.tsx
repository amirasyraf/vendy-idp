import type { ReactNode } from 'react';
import { Link } from '@backstage/core-components';
import { useMatch } from 'react-router-dom';
import { launchPath, products } from '../products/catalog';
import './launchForm.css';

/** Keep the stock wizard, but give the product request forms their own layout. */
export function LaunchFormLayout({ children }: { children: ReactNode }) {
  const match = useMatch('/create/templates/default/:templateName');
  const product = products.find(
    item => item.template === match?.params.templateName,
  );
  if (!product) return <>{children}</>;

  return (
    <div className="vendy-request">
      <nav aria-label="Launch breadcrumbs" className="vendy-request-trail">
        <Link to="/launch">Launch</Link>
        <span aria-hidden="true">›</span>
        <Link to={launchPath(product)}>{product.title}</Link>
      </nav>
      {children}
    </div>
  );
}
