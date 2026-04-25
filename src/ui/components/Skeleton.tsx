import { useTranslation } from "react-i18next";

export function Skeleton() {
  const { t } = useTranslation();
  return (
    <article className="card" aria-busy="true" aria-live="polite">
      <div className="skeleton skeleton--lg" />
      <div className="skeleton skeleton--line" style={{ width: "92%" }} />
      <div className="skeleton skeleton--line" style={{ width: "88%" }} />
      <div className="skeleton skeleton--line" style={{ width: "70%" }} />
      <div className="section-label">{t("result.whyReachOut")}</div>
      <div className="skeleton skeleton--line" style={{ width: "84%" }} />
      <div className="skeleton skeleton--line" style={{ width: "76%" }} />
      <div className="skeleton skeleton--line" style={{ width: "62%" }} />
      <div className="two-col">
        <section className="subcard">
          <div className="skeleton skeleton--line" style={{ width: "40%" }} />
          <div className="skeleton skeleton--line" style={{ width: "70%" }} />
          <div className="skeleton skeleton--line" style={{ width: "50%" }} />
        </section>
        <section className="subcard">
          <div className="skeleton skeleton--line" style={{ width: "60%" }} />
          <div className="skeleton skeleton--line" style={{ width: "80%" }} />
          <div className="skeleton skeleton--line" style={{ width: "55%" }} />
        </section>
      </div>
    </article>
  );
}
